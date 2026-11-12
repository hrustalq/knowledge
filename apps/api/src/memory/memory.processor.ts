import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MemoryOperationsService } from './memory-operations.service.js';
import { MEMORY_QUEUE, type MemoryQueueJob } from './memory.constants.js';

/** Worker half of async retain (#986 phase 3): the job names a row, the row holds the work. */
@Processor(MEMORY_QUEUE)
export class MemoryProcessor extends WorkerHost {
  constructor(private readonly operations: MemoryOperationsService) {
    super();
  }

  async process(job: Job<MemoryQueueJob>): Promise<void> {
    await this.operations.run(job.data.operationId);
  }
}
