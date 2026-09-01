import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IngestionJobInfo, ReindexResponse, StaleReportResponse } from '@knowledge/contracts';
import type { IngestionJob } from '@prisma/client';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { embeddingSignature } from '../embedding/embedding.provider.js';
import { IngestionProducer } from './ingestion.producer.js';

/**
 * Phase 5 API-side ingestion surface (plan.md §7/§11): job status, workspace
 * staleness report, and forced reindex of branch heads. The worker-side
 * StaleSweeper performs the same drift detection automatically.
 */
@Injectable()
export class IngestionAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: IngestionProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getJob(jobId: string): Promise<IngestionJobInfo> {
    const job = await this.prisma.ingestionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Ingestion job ${jobId} not found`);
    return this.toInfo(job);
  }

  async staleReport(workspaceId: string): Promise<StaleReportResponse> {
    const sig = embeddingSignature(this.config);
    const timeoutMs = this.config.get('STALE_INDEXING_TIMEOUT_MIN', { infer: true }) * 60_000;

    const heads = await this.prisma.documentBranch.findMany({
      where: { headRevisionId: { not: null }, document: { workspaceId } },
      select: { headRevisionId: true },
    });
    const driftedHeads = await this.prisma.documentRevision.findMany({
      where: {
        id: { in: heads.map((h) => h.headRevisionId as string) },
        status: 'indexed',
        OR: [{ embeddingModel: null }, { NOT: { embeddingModel: sig } }],
      },
      include: { document: true },
    });
    const [stuckIndexing, failedJobs] = await Promise.all([
      this.prisma.ingestionJob.findMany({
        where: { workspaceId, status: 'running', startedAt: { lt: new Date(Date.now() - timeoutMs) } },
      }),
      this.prisma.ingestionJob.findMany({
        where: { workspaceId, status: 'failed' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      workspaceId,
      embeddingSignature: sig,
      driftedHeads: driftedHeads.map((r) => ({
        documentId: r.documentId,
        revisionId: r.id,
        title: r.document.title,
        embeddingModel: r.embeddingModel,
        indexedAt: r.indexedAt?.toISOString() ?? null,
      })),
      stuckIndexing: stuckIndexing.map((j) => ({
        jobId: j.id,
        revisionId: j.revisionId,
        startedAt: j.startedAt?.toISOString() ?? null,
      })),
      failedJobs: failedJobs.map((j) => ({
        jobId: j.id,
        revisionId: j.revisionId,
        attempts: j.attempts,
        error: j.error,
      })),
    };
  }

  /** Enqueue reindex jobs for the workspace's (or one document's) branch heads. */
  async reindex(workspaceId: string, documentId?: string): Promise<ReindexResponse> {
    const branches = await this.prisma.documentBranch.findMany({
      where: {
        headRevisionId: { not: null },
        document: { workspaceId },
        ...(documentId ? { documentId } : {}),
      },
      select: { headRevisionId: true },
    });
    const revisions = await this.prisma.documentRevision.findMany({
      where: {
        id: { in: branches.map((b) => b.headRevisionId as string) },
        status: { in: ['indexed', 'failed'] },
      },
      include: { document: true },
    });

    const jobIds: string[] = [];
    for (const rev of revisions) {
      const job = await this.prisma.ingestionJob.create({
        data: {
          workspaceId,
          revisionId: rev.id,
          type: 'reindex',
          status: 'queued',
          payload: {
            documentId: rev.documentId,
            revisionId: rev.id,
            s3Key: rev.s3Key,
            title: rev.document.title,
            reason: 'manual reindex',
          },
        },
      });
      jobIds.push(job.id);
      await this.producer.enqueue(job.id).catch(() => {
        /* outbox sweeper re-enqueues */
      });
    }
    return { workspaceId, enqueued: jobIds.length, jobIds };
  }

  private toInfo(j: IngestionJob): IngestionJobInfo {
    return {
      jobId: j.id,
      workspaceId: j.workspaceId,
      revisionId: j.revisionId,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      error: j.error,
      startedAt: j.startedAt?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null,
      createdAt: j.createdAt.toISOString(),
    };
  }
}
