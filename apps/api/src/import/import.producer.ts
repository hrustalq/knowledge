import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IMPORT_QUEUE } from './import.constants.js';

@Injectable()
export class ImportProducer {
  constructor(@InjectQueue(IMPORT_QUEUE) private readonly queue: Queue) {}

  /**
   * jobId = import_jobs.id, so a double-start (an impatient click, a retried
   * request) collapses into the one job — the same guarantee
   * `IngestionProducer.enqueue` gives the outbox.
   *
   * `attempts: 1`: a parse failure is nearly always the file, not the run, and
   * silently reparsing a 50 MB PDF three times to reach the same conclusion
   * costs a minute of someone watching a ring.
   */
  async enqueue(importJobId: string): Promise<void> {
    await this.queue.add(
      'parse',
      { importJobId },
      { jobId: importJobId, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
  }
}
