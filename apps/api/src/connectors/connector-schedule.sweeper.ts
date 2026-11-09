import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requeueStale, staleFailure } from '../common/requeue-stale.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConnectorProducer } from './connector.producer.js';
import { aclSyncDue } from './connector-acl.js';
import { ConnectorsService } from './connectors.service.js';
import { Ticker } from '../common/ticker.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
/** A run still `queued` this long after its last slice (or its creation) has probably lost its job (#657). */
const STALE_QUEUED_MS = 15 * 60_000;
const RELAY_BATCH = 20;
/** Stale-run re-queues before a run whose worker keeps dying is failed (#809). */
const CONNECTOR_MAX_ATTEMPTS = 3;

/**
 * Enqueues scheduled syncs (docs/features/19), mirroring StaleSweeper, and
 * the ACL-only refreshes of connectors that mirror access (#76).
 *
 * The due check is `lastSyncedAt + interval <= now`, and `createRun` refuses a
 * second run while one is in flight — so a connector whose sync takes longer
 * than its interval falls behind rather than piling up, which is the behaviour
 * you want from a poller against a rate-limited API.
 *
 * It is also the outbox relay for `connector_runs` (#657), on whether or not
 * schedules are: a run is committed `queued` before its job, so a lost enqueue
 * would otherwise hold the connector's one in-flight slot until someone
 * cancelled by hand. `requeueStuck` is the same slot's other half: a run
 * whose worker died mid-slice (#809).
 */
@Injectable()
export class ConnectorScheduleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorScheduleSweeper.name);
  private readonly ticker = new Ticker(this.logger);
  private schedulesEnabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly producer: ConnectorProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.schedulesEnabled = this.config.get('CONNECTOR_SCHEDULE_ENABLED', { infer: true });
    if (!this.schedulesEnabled) {
      this.logger.log('Connector schedules disabled (CONNECTOR_SCHEDULE_ENABLED=false); run recovery stays on');
    }
    this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  /**
   * A first slice is enqueued again under the run's own id, so a job that is
   * merely waiting — or held back by the push debounce — absorbs it. A
   * continuation's last jobId is not recorded, so it gets one `#relay` job:
   * removed on completion, so a later relay can add it again, and a duplicate
   * of a live continuation loses the processor's `status: 'queued'` claim.
   */
  private async relayQueued(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_QUEUED_MS);
    const stale = await this.prisma.connectorRun.findMany({
      where: {
        status: 'queued',
        OR: [{ startedAt: null, createdAt: { lt: cutoff } }, { startedAt: { lt: cutoff } }],
      },
      select: { id: true, phase: true },
      orderBy: { createdAt: 'asc' },
      take: RELAY_BATCH,
    });
    for (const run of stale) {
      this.logger.log(`Re-enqueueing stale queued connector run ${run.id}`);
      if (run.phase === null) await this.producer.enqueue(run.id);
      else await this.producer.enqueueRetry(run.id, 'relay');
    }
  }

  /**
   * A `running` run whose worker died, back to `queued` (#809). Each slice's
   * claim stamps `startedAt`, and a live slice yields or aborts within
   * CONNECTOR_SYNC_TIMEOUT_MS, so twice that untouched is dead. The processor
   * puts the dead slice's half-done items back when it claims the run.
   */
  private async requeueStuck(): Promise<void> {
    await requeueStale({
      staleField: 'startedAt',
      staleMs: 2 * this.config.get('CONNECTOR_SYNC_TIMEOUT_MS', { infer: true }),
      maxAttempts: CONNECTOR_MAX_ATTEMPTS,
      find: (where) =>
        this.prisma.connectorRun.findMany({ where, select: { id: true, attempt: true }, take: RELAY_BATCH }),
      attemptOf: (run) => run.attempt,
      requeue: (where, run) => {
        this.logger.warn(`Connector run ${run.id} stuck in 'running' — re-queueing`);
        return this.prisma.connectorRun.updateMany({ where, data: { status: 'queued', attempt: { increment: 1 } } });
      },
      fail: (where) =>
        this.prisma.connectorRun.updateMany({
          where,
          data: {
            status: 'failed',
            stage: null,
            progress: null,
            error: { message: staleFailure(CONNECTOR_MAX_ATTEMPTS + 1) },
            completedAt: new Date(),
          },
        }),
      enqueue: (run) => this.producer.enqueueRetry(run.id, `stale-${run.attempt + 1}`),
    });
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      await this.relayQueued();
      // After the relay: a run re-queued here still has an old `startedAt`, so
      // the relay would enqueue it a second time in the same tick.
      await this.requeueStuck();
      if (!this.schedulesEnabled) return;
      const due = await this.prisma.connector.findMany({
        where: {
          enabled: true,
          OR: [{ syncIntervalMinutes: { not: null } }, { aclMode: { not: 'off' } }],
          // Web sources off (#674): their schedules wait rather than failing every tick.
          ...(this.connectors.webSourcesEnabled ? {} : { kind: { not: 'web' } }),
        },
      });
      const now = Date.now();
      const aclDefault = this.config.get('CONNECTOR_ACL_SYNC_DEFAULT_MIN', { infer: true });

      for (const connector of due) {
        // The ACL-only refresh (#76) is its own due check on its own interval:
        // permission calls are cheap enough to run far more often than a pull.
        if (connector.aclMode !== 'off' && aclSyncDue(connector.aclSyncedAt, connector.aclSyncIntervalMinutes ?? aclDefault, now)) {
          await this.producer.enqueueAcl(connector.id).catch((err: unknown) =>
            this.logger.warn({ msg: 'Connector ACL refresh could not be queued', connectorId: connector.id, err }),
          );
        }

        const interval = (connector.syncIntervalMinutes ?? 0) * 60_000;
        if (interval <= 0) continue;
        const last = connector.lastSyncedAt?.getTime() ?? 0;
        if (last + interval > now) continue;

        const direction = connector.direction === 'push' ? 'push' : 'pull';
        try {
          const run = await this.connectors.createRun(connector, direction, 'schedule');
          await this.producer.enqueue(run.id);
        } catch (err) {
          // Still non-fatal, for the original reason: a run already in flight,
          // or a connector that cannot do this direction, are both ordinary and
          // must not stop the sweep.
          //
          // Logged rather than silent because from here those ordinary cases are
          // indistinguishable from a real failure — a connector that has not
          // synced for a week looked exactly like one that had nothing to do.
          this.logger.warn({
            msg: 'Scheduled connector run could not start',
            code: 'SCHEDULED_RUN_FAILED',
            connectorId: connector.id,
            direction,
            err,
          });
        }
      }
    });
  }
}
