import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { asLocale } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SWEEP_INTERVAL_MS = 30_000;
const BATCH = 20;

/**
 * Turns recorded pull conflicts into merge requests (docs/features/19).
 *
 * API-side on purpose: MergeRequestsService injects AccessService from the
 * global AuthModule, which the worker never registers. This is the feature-17
 * materialize-sweeper trick, and it fits here because conflicts are the
 * exceptional path — the bulk of a sync writes pages directly from the worker
 * through DocumentsCoreModule. It doubles as recovery when the API dies between
 * the worker recording a conflict and the merge request existing.
 */
@Injectable()
export class ConnectorConflictSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorConflictSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mergeRequests: MergeRequestsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // On a 30s tick against a batch of 20 merge-request creations, a slow sweep
    // can still be running when the next fires — and both would read the same
    // `pending` rows and open the merge request twice.
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.prisma.connectorConflict.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        include: { connector: true },
      });

      for (const conflict of pending) {
        try {
          const created = await withLocale(asLocale(conflict.connector.locale), () =>
            this.mergeRequests.create(conflict.documentId, {
              sourceBranch: conflict.branch,
              title: t('connector.mr.title', {
                name: conflict.connector.name,
                title: conflict.title,
              }).slice(0, 300),
              description: t('connector.mr.description', {
                name: conflict.connector.name,
                url: conflict.externalUrl ?? '—',
              }),
            }),
          );
          await this.prisma.connectorConflict.update({
            where: { id: conflict.id },
            data: {
              status: 'resolved',
              mergeRequestId: created.mergeRequest.mergeRequestId,
              resolvedAt: new Date(),
            },
          });
        } catch (err) {
          // Record and move on: one unopenable merge request (the branch was
          // deleted, say) must not block every other conflict behind it.
          await this.prisma.connectorConflict.update({
            where: { id: conflict.id },
            data: { status: 'failed', error: (err as Error).message.slice(0, 500) },
          });
          this.logger.warn(`Conflict ${conflict.id} could not become a merge request: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Connector conflict sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
