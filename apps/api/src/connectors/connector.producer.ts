import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { CONNECTOR_QUEUE } from './connector.constants.js';

export interface ConnectorJobData {
  runId: string;
}

@Injectable()
export class ConnectorProducer {
  constructor(@InjectQueue(CONNECTOR_QUEUE) private readonly queue: Queue<ConnectorJobData>) {}

  /**
   * jobId = connector_runs.id, so a double-enqueue collapses into one job.
   * attempts: 1 — a sync failure is recorded on the row and a blind retry would
   * re-run the same external calls (ImportProducer's reasoning).
   */
  async enqueue(runId: string): Promise<void> {
    await this.queue.add(
      'sync',
      { runId },
      { jobId: runId, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }

  /** BullMQ keeps failed jobs, so a sweeper retry needs a fresh id. */
  async enqueueRetry(runId: string, salt: string): Promise<void> {
    await this.queue.add(
      'sync',
      { runId },
      { jobId: `${runId}#${salt}`, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }
}
