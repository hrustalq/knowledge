import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConnectorProducer } from './connector.producer.js';
import { ConnectorsService } from './connectors.service.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Enqueues scheduled syncs (docs/features/19), mirroring StaleSweeper.
 *
 * The due check is `lastSyncedAt + interval <= now`, and `createRun` refuses a
 * second run while one is in flight — so a connector whose sync takes longer
 * than its interval falls behind rather than piling up, which is the behaviour
 * you want from a poller against a rate-limited API.
 */
@Injectable()
export class ConnectorScheduleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorScheduleSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly producer: ConnectorProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('CONNECTOR_SCHEDULE_ENABLED', { infer: true })) {
      this.logger.log('Connector schedule sweeper disabled (CONNECTOR_SCHEDULE_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return; // a slow sweep must not stack on itself
    this.running = true;
    try {
      const due = await this.prisma.connector.findMany({
        where: { enabled: true, syncIntervalMinutes: { not: null } },
      });
      const now = Date.now();

      for (const connector of due) {
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
    } catch (err) {
      this.logger.warn(`Connector schedule sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
