import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AGENT_QUEUE } from './agent.constants.js';

@Injectable()
export class AgentProducer {
  constructor(@InjectQueue(AGENT_QUEUE) private readonly queue: Queue) {}

  /**
   * `jobId = agent_runs.id`, so a double-click on Run and a sweeper re-queue
   * collapse into one job — the guarantee every producer in this repo gives.
   *
   * `attempts: 1` because a failed agent run has almost always failed on its
   * prompt or its provider, and burning three model calls to reach the same
   * answer costs real money (the ImportProducer/WorkflowProducer reasoning).
   */
  async enqueue(runId: string): Promise<void> {
    await this.queue.add(
      'run',
      { runId },
      { jobId: runId, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }

  /** A retry needs a fresh jobId: the kept failed job blocks reuse of the old one. */
  async enqueueRetry(runId: string, attempt: number): Promise<void> {
    await this.queue.add(
      'run',
      { runId },
      { jobId: `${runId}:${attempt}`, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }
}
