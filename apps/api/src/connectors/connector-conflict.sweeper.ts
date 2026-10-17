import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Connector, ConnectorConflict } from '@prisma/client';
import matter from 'gray-matter';
import { SUPERSEDING_CONFLICT_REASONS, type ConnectorConflictReason } from '@knowledge/contracts';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { asLocale } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

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
    private readonly storage: StorageService,
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
          if (supersedes(conflict.reason) && (await this.supersededBeforeOpening(conflict))) continue;
          const created = await withLocale(asLocale(conflict.connector.locale), async () =>
            this.mergeRequests.create(
              conflict.documentId,
              await this.mergeRequestText(conflict, conflict.connector),
              // A regenerated wiki page is the connector owner's act (docs/features/46):
              // their agent wrote it, their budget paid for it. A conflict keeps
              // the stub it always had — nobody in particular raised it.
              conflict.reason === 'regenerated' && conflict.connector.createdBy ? conflict.connector.createdBy : undefined,
            ),
          );
          await this.prisma.connectorConflict.update({
            where: { id: conflict.id },
            data: {
              status: 'resolved',
              mergeRequestId: created.mergeRequest.mergeRequestId,
              resolvedAt: new Date(),
            },
          });
          if (supersedes(conflict.reason)) await this.closeOlder(conflict);
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

  /** The merge request's title and description, by why the conflict row exists. */
  private async mergeRequestText(
    conflict: ConnectorConflict,
    connector: Connector,
  ): Promise<{ sourceBranch: string; title: string; description: string }> {
    if (conflict.reason === 'spec-changed') {
      return {
        sourceBranch: conflict.branch,
        title: t('connector.mr.specTitle', { name: connector.name, title: conflict.title }).slice(0, 300),
        description: t('connector.mr.specDescription', { name: connector.name, url: conflict.externalUrl ?? '—' }),
      };
    }
    if (conflict.reason !== 'regenerated') {
      return {
        sourceBranch: conflict.branch,
        title: t('connector.mr.title', { name: connector.name, title: conflict.title }).slice(0, 300),
        description: t('connector.mr.description', { name: connector.name, url: conflict.externalUrl ?? '—' }),
      };
    }
    // The commit the page was generated from rides in its own frontmatter, so
    // the description is derived from the revision rather than stored twice.
    const generated = await this.generatedFrom(conflict.revisionId);
    return {
      sourceBranch: conflict.branch,
      title: t('connector.mr.wikiTitle', { name: connector.name, title: conflict.title }).slice(0, 300),
      description: t('connector.mr.wikiDescription', {
        name: connector.name,
        url: conflict.externalUrl ?? '—',
        commit: generated.headSha ? generated.headSha.slice(0, 12) : '—',
        unit: generated.unit ?? '—',
      }),
    };
  }

  private async generatedFrom(revisionId: string): Promise<{ headSha?: string; unit?: string }> {
    try {
      const revision = await this.prisma.documentRevision.findUnique({ where: { id: revisionId }, select: { s3Key: true } });
      if (!revision) return {};
      const data = matter(await this.storage.getObjectText(revision.s3Key)).data as Record<string, unknown>;
      return {
        ...(typeof data.headSha === 'string' ? { headSha: data.headSha } : {}),
        ...(typeof data.unit === 'string' ? { unit: data.unit } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * A newer regeneration (or spec change, #78) of the same page is already
   * waiting: opening this one would be a merge request born superseded.
   * Marked and skipped, oldest first, so only the newest of a burst ever
   * becomes a merge request.
   */
  private async supersededBeforeOpening(conflict: ConnectorConflict): Promise<boolean> {
    const newer = await this.prisma.connectorConflict.findFirst({
      where: {
        documentId: conflict.documentId,
        reason: conflict.reason,
        status: 'pending',
        createdAt: { gt: conflict.createdAt },
      },
      select: { id: true },
    });
    if (!newer) return false;
    await this.prisma.connectorConflict.update({
      where: { id: conflict.id },
      data: { status: 'superseded', resolvedAt: new Date() },
    });
    return true;
  }

  /**
   * Close the regeneration (or spec change) merge requests this one replaces
   * (docs/features/46). Only ones still open: a merged one is history, and a
   * closed one was already decided. Attributed to the connector owner.
   */
  private async closeOlder(conflict: ConnectorConflict & { connector: Connector }): Promise<void> {
    const older = await this.prisma.connectorConflict.findMany({
      where: {
        documentId: conflict.documentId,
        reason: conflict.reason,
        status: 'resolved',
        id: { not: conflict.id },
        mergeRequestId: { not: null },
      },
      select: { mergeRequestId: true },
    });
    for (const row of older) {
      try {
        const { mergeRequest } = await this.mergeRequests.get(row.mergeRequestId!);
        if (mergeRequest.status !== 'open') continue;
        await this.mergeRequests.close(row.mergeRequestId!, conflict.connector.createdBy ?? undefined);
      } catch (err) {
        this.logger.warn(`Could not close superseded merge request ${row.mergeRequestId}: ${(err as Error).message}`);
      }
    }
  }
}

/** Whether a newer row of this reason replaces an older one's merge request. */
function supersedes(reason: string): boolean {
  return SUPERSEDING_CONFLICT_REASONS.includes(reason as ConnectorConflictReason);
}
