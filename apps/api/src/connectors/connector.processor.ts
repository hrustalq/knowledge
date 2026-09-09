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
import type { ConnectorJobData } from './connector.producer.js';
import { ConnectorSyncService } from './connector-sync.service.js';
import { ConnectorsService } from './connectors.service.js';

/**
 * Runs one sync (docs/features/19).
 *
 * Follows ImportProcessor exactly, including the two decisions that matter: the
 * row is claimed idempotently so a re-delivery cannot double-run, and a failure
 * is **written to the row rather than rethrown** — letting BullMQ retry would
 * re-run the same external calls against the same unchanged upstream.
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
    // already-running job is a no-op rather than a second concurrent sync.
    const claimed = await this.prisma.connectorRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), stage: null, progress: null, error: Prisma.DbNull },
    });
    if (claimed.count === 0) return;

    const run = await this.prisma.connectorRun.findUniqueOrThrow({ where: { id: runId } });
    const connector = await this.prisma.connector.findUnique({ where: { id: run.connectorId } });
    if (!connector) {
      await this.fail(runId, 'the connector was deleted');
      return;
    }

    await this.events.publish({
      workspaceId: run.workspaceId,
      type: 'connector.run.started',
      subjectId: connector.id,
      title: connector.name,
    });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      await this.sync.run(connector, run, abort.signal);
    } catch (err) {
      const message = abort.signal.aborted
        ? `the sync exceeded ${Math.round(this.timeoutMs / 1000)}s and was stopped`
        : (err as Error).message;
      this.logger.error(`Connector run ${runId} failed: ${message}`);
      await this.fail(runId, message);
      await this.events.publish({
        workspaceId: run.workspaceId,
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
