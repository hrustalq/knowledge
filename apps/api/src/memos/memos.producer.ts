import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MEMO_QUEUE } from './memos.constants.js';

@Injectable()
export class MemosProducer {
  constructor(@InjectQueue(MEMO_QUEUE) private readonly queue: Queue) {}

  /**
   * jobId = memo id, so a double finalize collapses into one job. Removed on
   * either outcome, so a Retry can add the same id again. `attempts: 1`: a
   * failed transcription is the file or the server, and the row says which.
   */
  async enqueue(memoId: string): Promise<void> {
    await this.queue.add('transcribe', { memoId }, { jobId: memoId, attempts: 1, removeOnComplete: true, removeOnFail: true });
  }
}
