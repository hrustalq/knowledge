import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { IngestionProducer } from './ingestion.producer.js';

const logger = new Logger('Reindex');

/** The revision to reindex, and what its job payload records about why. */
interface ReindexTarget {
  workspaceId: string;
  documentId: string;
  revisionId: string;
  s3Key: string;
  title: string;
  reason: string;
  /** The page whose change caused this one (dependent reindex). */
  triggeredBy?: string;
}

/**
 * Queue a reindex through the outbox: the `ingestion_jobs` row first, then
 * the BullMQ job. A failed enqueue is logged and left to OutboxSweeper, which
 * re-enqueues anything still `queued`.
 *
 * With `skipPending`, a revision that already has a queued or running job is
 * left to it and the result is null. A manual reindex passes false: a job
 * stuck `running` is exactly what it is for.
 */
export async function queueReindex(
  prisma: Pick<PrismaService, 'ingestionJob'>,
  producer: Pick<IngestionProducer, 'enqueue'>,
  target: ReindexTarget,
  { skipPending }: { skipPending: boolean },
): Promise<string | null> {
  const { workspaceId, ...payload } = target;
  if (skipPending) {
    const pending = await prisma.ingestionJob.findFirst({
      where: { revisionId: target.revisionId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (pending) return null;
  }
  const job = await prisma.ingestionJob.create({
    data: { workspaceId, revisionId: target.revisionId, type: 'reindex', status: 'queued', payload: { ...payload } },
  });
  await producer.enqueue(job.id).catch((err: unknown) => {
    // Logged because "the sweeper will pick it up in a moment" and "every
    // enqueue is failing" are indistinguishable from here: the second shows
    // only as unexplained indexing latency, with nothing to grep for.
    logger.warn({
      msg: 'Reindex enqueue failed (outbox sweeper will retry)',
      code: 'JOB_ENQUEUE_FAILED',
      ingestionJobId: job.id,
      documentId: target.documentId,
      err,
    });
  });
  return job.id;
}
