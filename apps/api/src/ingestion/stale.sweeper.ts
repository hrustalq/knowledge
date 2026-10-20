import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { embeddingSignature } from '../embedding/embedding.provider.js';
import { GraphService } from '../graph/graph.service.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';
import { IngestionProducer } from './ingestion.producer.js';
import { loadRevisionStamps } from '../graph/revision-stamps.js';

/** Revisions re-mirrored into the BM25 index per sweep; the next sweep continues. */
const FULLTEXT_REPAIR_BATCH = 25;

/**
 * Phase 5 stale-document detection & reindex scheduling (plan.md §11):
 *  a) jobs stuck 'running' past STALE_INDEXING_TIMEOUT_MIN are re-queued;
 *  b) 'failed' jobs under STALE_MAX_ATTEMPTS are retried;
 *  c) branch heads indexed under a different embedding signature (provider/
 *     model/dim change — or before signatures existed) are reindexed, capped
 *     per sweep so a model swap rolls through the corpus gradually;
 *  d) revisions whose BM25 write failed (#173) are re-mirrored into the
 *     fulltext index from the graph's chunks — no re-embedding.
 */
@Injectable()
export class StaleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: IngestionProducer,
    private readonly config: ConfigService<Env, true>,
    private readonly graph: GraphService,
    @Inject(FULLTEXT_PROVIDER) private readonly fulltext: FulltextProvider,
  ) {}

  onModuleInit() {
    if (!this.config.get('STALE_SWEEP_ENABLED', { infer: true })) {
      this.logger.log('Stale sweeper disabled (STALE_SWEEP_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), 5 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // Reindexes up to 10 documents a tick; overlapping sweeps would re-queue
    // the same drifted heads twice before the first pass had updated any.
    if (this.running) return;
    this.running = true;
    try {
      await this.requeueStuck();
      await this.retryFailed();
      await this.reindexDrifted();
      await this.repairFulltext();
    } catch (e) {
      this.logger.warn(`Stale sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async requeueStuck(): Promise<void> {
    const timeoutMs = this.config.get('STALE_INDEXING_TIMEOUT_MIN', { infer: true }) * 60_000;
    const stuck = await this.prisma.ingestionJob.findMany({
      where: { status: 'running', startedAt: { lt: new Date(Date.now() - timeoutMs) } },
      take: 10,
    });
    for (const job of stuck) {
      this.logger.warn(`Job ${job.id} stuck in 'running' — re-queueing`);
      await this.prisma.ingestionJob.update({ where: { id: job.id }, data: { status: 'queued' } });
      await this.producer.enqueueRetry(job.id, job.attempts);
    }
  }

  private async retryFailed(): Promise<void> {
    const maxAttempts = this.config.get('STALE_MAX_ATTEMPTS', { infer: true });
    const failed = await this.prisma.ingestionJob.findMany({
      where: {
        status: 'failed',
        attempts: { lt: maxAttempts },
        createdAt: { lt: new Date(Date.now() - 2 * 60_000) },
      },
      take: 10,
      orderBy: { createdAt: 'asc' },
    });
    for (const job of failed) {
      this.logger.log(`Retrying failed job ${job.id} (attempts so far: ${job.attempts}/${maxAttempts})`);
      await this.prisma.ingestionJob.update({ where: { id: job.id }, data: { status: 'queued' } });
      await this.producer.enqueueRetry(job.id, job.attempts);
    }
  }

  private async reindexDrifted(): Promise<void> {
    const sig = embeddingSignature(this.config);
    const heads = await this.prisma.documentBranch.findMany({
      where: { headRevisionId: { not: null } },
      select: { headRevisionId: true },
    });
    const headIds = heads.map((h) => h.headRevisionId as string);
    if (headIds.length === 0) return;

    const drifted = await this.prisma.documentRevision.findMany({
      where: {
        id: { in: headIds },
        status: 'indexed',
        OR: [{ embeddingModel: null }, { NOT: { embeddingModel: sig } }],
      },
      include: { document: true },
      take: 10, // cap churn per sweep; the next sweep continues the rollout
    });
    for (const rev of drifted) {
      const pending = await this.prisma.ingestionJob.findFirst({
        where: { revisionId: rev.id, status: { in: ['queued', 'running'] } },
      });
      if (pending) continue;
      const job = await this.prisma.ingestionJob.create({
        data: {
          workspaceId: rev.document.workspaceId,
          revisionId: rev.id,
          type: 'reindex',
          status: 'queued',
          payload: {
            documentId: rev.documentId,
            revisionId: rev.id,
            s3Key: rev.s3Key,
            title: rev.document.title,
            reason: `embedding drift: ${rev.embeddingModel ?? 'unknown'} -> ${sig}`,
          },
        },
      });
      this.logger.log(
        `Embedding drift on revision ${rev.id} (${rev.embeddingModel ?? 'unknown'} -> ${sig}) — reindex job ${job.id}`,
      );
      await this.producer.enqueue(job.id);
    }
  }

  /**
   * Re-mirror revisions whose BM25 write failed (#173): their chunks never
   * reached the fulltext index, or their live flip did not, so keyword search
   * missed the page or kept ranking superseded text.
   *
   * The chunks come from the graph, which holds them as indexed, so nothing is
   * re-chunked or re-embedded. The stamp clears only if it is still the one this
   * sweep read: a failure that landed meanwhile keeps the revision due. The
   * first failure ends the sweep — an index still down would fail every row.
   */
  async repairFulltext(): Promise<number> {
    if (!this.fulltext.enabled) return 0;
    const due = await this.prisma.documentRevision.findMany({
      where: { fulltextStaleAt: { not: null }, status: 'indexed' },
      select: {
        id: true,
        documentId: true,
        fulltextStaleAt: true,
        document: {
          select: {
            workspaceId: true,
            restrictedBy: true,
            defaultBranch: true,
            branches: { select: { name: true, headRevisionId: true } },
          },
        },
      },
      orderBy: { fulltextStaleAt: 'asc' },
      take: FULLTEXT_REPAIR_BATCH,
    });
    let repaired = 0;
    for (const rev of due) {
      const { workspaceId, restrictedBy, defaultBranch, branches } = rev.document;
      const live = branches.find((b) => b.name === defaultBranch)?.headRevisionId === rev.id;
      try {
        const chunks = await this.graph.getRevisionChunkTexts(workspaceId, rev.id);
        await this.fulltext.indexRevisionChunks(
          workspaceId,
          rev.id,
          chunks.map((c) => ({ ...c, revisionId: rev.id })),
          { live, aclNodes: restrictedBy },
        );
        if (live) await this.fulltext.setLiveRevision(workspaceId, rev.documentId, rev.id);
        // Re-mirrored rows are written unstamped (#81).
        const stamp = (await loadRevisionStamps(this.prisma, rev.documentId)).filter((s) => s.revisionId === rev.id);
        await this.fulltext.stampRevisions(workspaceId, rev.documentId, stamp);
      } catch (e) {
        this.logger.warn(`Fulltext repair failed for revision ${rev.id}; retrying next sweep: ${(e as Error).message}`);
        break;
      }
      const { count } = await this.prisma.documentRevision.updateMany({
        where: { id: rev.id, fulltextStaleAt: rev.fulltextStaleAt },
        data: { fulltextStaleAt: null },
      });
      repaired += count;
    }
    if (repaired) this.logger.log(`Re-mirrored ${repaired} revision(s) into the fulltext index`);
    return repaired;
  }
}
