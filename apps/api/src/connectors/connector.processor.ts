import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import type { Env } from '../config/env.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { asLocale } from '../i18n/locale.js';
import { withLocale } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CONNECTOR_QUEUE } from './connector.constants.js';
import { ConnectorProducer, type ConnectorJobData } from './connector.producer.js';
import { ConnectorSyncService } from './connector-sync.service.js';
import { ConnectorsService } from './connectors.service.js';

/**
 * Runs one sync (docs/features/19, sliced by 26).
 *
 * Follows ImportProcessor exactly, including the two decisions that matter: the
 * row is claimed idempotently so a re-delivery cannot double-run, and a failure
 * is **written to the row rather than rethrown** — letting BullMQ retry would
 * re-run the same external calls against the same unchanged upstream.
 *
 * Feature 26 made the body a loop over budgeted slices instead of one call. The
 * run row is re-read between slices, which is the entire pause mechanism: the
 * API writes `paused`, and the next slice simply never starts. It is also what
 * lets a space larger than the sync timeout finish, by checkpointing and
 * re-enqueueing rather than being aborted.
 */
@Processor(CONNECTOR_QUEUE)
export class ConnectorProcessor extends WorkerHost {
  private readonly logger = new Logger(ConnectorProcessor.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly sync: ConnectorSyncService,
    private readonly producer: ConnectorProducer,
    private readonly events: EventsPublisher,
  ) {
    super();
    this.timeoutMs = this.config.get('CONNECTOR_SYNC_TIMEOUT_MS', { infer: true });
  }

  async process(job: Job<ConnectorJobData>): Promise<void> {
    const run = await this.prisma.connectorRun.findUnique({ where: { id: job.data.runId } });
    if (!run) {
      this.logger.warn(`Connector run ${job.data.runId} not found — skipping`);
      return;
    }
    // Everything below runs in the language the connector was configured in.
    return withLocale(asLocale(run.locale), () => this.execute(run.id));
  }

  private async execute(runId: string): Promise<void> {
    // Guarded claim: only a queued run is ours to start, so a re-delivery of an
    // already-running job is a no-op rather than a second concurrent sync. A
    // resumed run is queued again by the API, so this covers continuations too.
    const claimed = await this.prisma.connectorRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), stage: null, progress: null, error: Prisma.DbNull },
    });
    if (claimed.count === 0) return;

    const first = await this.prisma.connectorRun.findUniqueOrThrow({ where: { id: runId } });
    const connector = await this.prisma.connector.findUnique({ where: { id: first.connectorId } });
    if (!connector) {
      await this.fail(runId, 'the connector was deleted');
      return;
    }

    // Only the first slice announces the run; a continuation is the same run.
    if (first.phase === null) {
      await this.events.publish({
        workspaceId: first.workspaceId,
        type: 'connector.run.started',
        subjectId: connector.id,
        title: connector.name,
      });
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    // Leave room to checkpoint and re-enqueue before the abort fires, so a big
    // space continues in a fresh job instead of dying at the timeout.
    const yieldAt = Date.now() + this.timeoutMs * 0.9;

    try {
      for (;;) {
        // Re-read every slice: this is where a PAUSE or a CANCEL is noticed.
        // The API sets the status; the worker simply stops asking for more.
        const run = await this.prisma.connectorRun.findUnique({ where: { id: runId } });
        if (!run || run.status !== 'running') {
          this.logger.log(`Connector run ${runId} stopped: status is ${run?.status ?? 'gone'}`);
          return;
        }

        const step = await this.sync.run(connector, run, abort.signal);
        if (step.done) return;

        if (Date.now() > yieldAt) {
          // Fresh jobId, because the completed job blocks reuse of the original
          // — StaleSweeper.enqueueRetry's reasoning, applied to a continuation.
          const attempt = run.discovered + run.applied;
          await this.prisma.connectorRun.update({ where: { id: runId }, data: { status: 'queued' } });
          await this.producer.enqueueRetry(runId, String(attempt));
          this.logger.log(`Connector run ${runId} checkpointed and re-enqueued`);
          return;
        }
      }
    } catch (err) {
      const message = abort.signal.aborted
        ? `the sync exceeded ${Math.round(this.timeoutMs / 1000)}s and was stopped`
        : (err as Error).message;
      this.logger.error(`Connector run ${runId} failed: ${message}`);
      await this.fail(runId, message);
      await this.events.publish({
        workspaceId: first.workspaceId,
        type: 'connector.run.failed',
        subjectId: connector.id,
        title: connector.name,
      });
      // Deliberately swallowed: the row already carries the failure, and a
      // BullMQ retry would repeat an identical run against the same upstream.
    } finally {
      clearTimeout(timer);
    }
  }

  private async fail(runId: string, message: string): Promise<void> {
    await this.prisma.connectorRun
      .update({
        where: { id: runId },
        data: {
          status: 'failed',
          stage: null,
          progress: null,
          error: { message: message.slice(0, 1000) },
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}
