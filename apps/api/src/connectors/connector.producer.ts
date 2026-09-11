import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { CONNECTOR_QUEUE } from './connector.constants.js';

/**
 * A scoped pass that does **not** advance the run (docs/features/26).
 *
 * `fill` stages the named items; `apply` writes whatever is already approved.
 * Neither touches `status`, `phase` or `cursor`, which is what lets a paused
 * walk be worked with while staying paused with its frontier intact. The intent
 * rides on the job payload rather than on the row for the reason the ingestion
 * cascade carries `payload.reason='dependent-reindex'` there: the row is the
 * checkpoint, and a scoped pass must not be able to move it.
 */
export type ConnectorTask = { kind: 'fill'; itemIds: string[] } | { kind: 'apply' };

export interface ConnectorJobData {
  runId: string;
  task?: ConnectorTask;
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

  /**
   * A scoped pass over one run. Its jobId is namespaced by kind so it can never
   * collide with the run's own continuation — a fill asked for while the walk is
   * checkpointing must not be swallowed as a duplicate of it.
   */
  async enqueueTask(runId: string, task: ConnectorTask, salt: string): Promise<void> {
    await this.queue.add(
      'sync',
      { runId, task },
      { jobId: `${runId}#${task.kind}#${salt}`, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }
}
