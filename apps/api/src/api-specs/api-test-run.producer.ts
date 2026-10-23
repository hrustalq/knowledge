import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const API_TEST_RUN_QUEUE = 'api-test-runs';

/**
 * Enqueue side of the QA server runner (#483, phase 5). The job carries the
 * run's id and nothing else: the plan is on the row, and the values come from
 * the environment when the worker runs it — no secret ever sits in Redis.
 * One attempt: a run that died mid-suite has already sent requests, and
 * replaying setup against a live server is not a retry.
 */
@Injectable()
export class ApiTestRunProducer {
  constructor(@InjectQueue(API_TEST_RUN_QUEUE) private readonly queue: Queue) {}

  async enqueue(runId: string): Promise<void> {
    await this.queue.add('run', { runId }, { jobId: runId, attempts: 1, removeOnComplete: true, removeOnFail: { age: 86_400 } });
  }
}
