import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { INGESTION_QUEUE } from './ingestion.constants.js';

@Injectable()
export class IngestionProducer {
  constructor(@InjectQueue(INGESTION_QUEUE) private readonly queue: Queue) {}

  /** jobId = ingestion_jobs.id → BullMQ dedupes re-enqueues from the outbox sweeper. */
  async enqueue(ingestionJobId: string): Promise<void> {
    await this.queue.add(
      'index',
      { ingestionJobId },
      {
        jobId: ingestionJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  /**
   * Phase 5 sweeper retries: BullMQ dedupes by jobId and keeps failed jobs
   * (removeOnFail: false), so a retry needs a fresh id. The processor is
   * idempotent (completed-guard + delete-before-recreate), making any
   * resulting double-run harmless.
   */
  async enqueueRetry(ingestionJobId: string, salt: string | number): Promise<void> {
    await this.queue.add(
      'index',
      { ingestionJobId },
      {
        jobId: `${ingestionJobId}#${salt}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
