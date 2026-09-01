import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { embeddingSignature } from '../embedding/embedding.provider.js';
import { IngestionProducer } from './ingestion.producer.js';

/**
 * Phase 5 stale-document detection & reindex scheduling (plan.md §11):
 *  a) jobs stuck 'running' past STALE_INDEXING_TIMEOUT_MIN are re-queued;
 *  b) 'failed' jobs under STALE_MAX_ATTEMPTS are retried;
 *  c) branch heads indexed under a different embedding signature (provider/
 *     model/dim change — or before signatures existed) are reindexed, capped
 *     per sweep so a model swap rolls through the corpus gradually.
 */
@Injectable()
export class StaleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: IngestionProducer,
    private readonly config: ConfigService<Env, true>,
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
    try {
      await this.requeueStuck();
      await this.retryFailed();
      await this.reindexDrifted();
    } catch (e) {
      this.logger.warn(`Stale sweep failed: ${(e as Error).message}`);
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
}
