import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { MEMORY_QUEUE, type MemoryQueueJob } from './memory.constants.js';

@Injectable()
export class MemoryProducer {
  constructor(@InjectQueue(MEMORY_QUEUE) private readonly queue: Queue<MemoryQueueJob>) {}

  /**
   * The job carries the row id and nothing else. `jobId` is that id, so a
   * re-submit and the sweeper's re-enqueue of a row the queue still holds
   * collapse into one job. A re-run after a dead worker needs a fresh id — the
   * stalled job still owns the old one — hence `attempt` (joined with `-`:
   * BullMQ refuses a `:` in a custom id). `attempts: 1`:
   * recovery is the sweeper's, by the row, not the queue's.
   */
  async enqueue(operationId: string, attempt = 0): Promise<void> {
    await this.queue.add(
      'retain',
      { operationId },
      { jobId: attempt ? `${operationId}-${attempt}` : operationId, attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
  }
}
