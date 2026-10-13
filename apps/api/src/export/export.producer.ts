import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EXPORT_QUEUE, type ExportQueueJob } from './export.constants.js';

@Injectable()
export class ExportProducer {
  constructor(@InjectQueue(EXPORT_QUEUE) private readonly queue: Queue<ExportQueueJob>) {}

  /**
   * jobId = export_jobs.id, so a retried request collapses into the one job.
   * `attempts: 1`, as for imports: a failed export is nearly always the
   * content or the converter, and the row already says which; rerunning it
   * would only reach the same answer later.
   */
  async enqueue(exportId: string): Promise<void> {
    await this.queue.add(
      'export',
      { exportId },
      { jobId: exportId, attempts: 1, removeOnComplete: true, removeOnFail: { age: 7 * 86_400 } },
    );
  }
}
