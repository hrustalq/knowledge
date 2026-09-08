import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WORKFLOW_QUEUE } from './workflow.constants.js';

@Injectable()
export class WorkflowProducer {
  constructor(@InjectQueue(WORKFLOW_QUEUE) private readonly queue: Queue) {}

  /**
   * `jobId = workflow_run_nodes.id`, so an impatient double-approve or a
   * re-queued sweep collapses into one job — the same guarantee
   * `IngestionProducer.enqueue` gives the outbox.
   *
   * `attempts: 1` for the same reason `ImportProducer` uses it: a step that
   * failed almost always failed on its prompt, and burning three model calls
   * to reach the same conclusion costs real money.
   */
  async enqueue(nodeId: string): Promise<void> {
    await this.queue.add(
      'step',
      { nodeId },
      { jobId: nodeId, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }

  /** A retry needs a fresh jobId: the kept failed job blocks reuse of the old one. */
  async enqueueRetry(nodeId: string, attempt: number): Promise<void> {
    await this.queue.add(
      'step',
      { nodeId },
      { jobId: `${nodeId}:${attempt}`, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }
}
