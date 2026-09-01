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
}
