import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MemoryCoreModule } from './memory-core.module.js';
import { MemoryQueueModule } from './memory-queue.module.js';
import { MemoryReapSweeper } from './memory-reap.sweeper.js';
import { MemoryProcessor } from './memory.processor.js';

/**
 * Memory banks (#986), the worker's half: the async-retain consumer and the
 * reap of vectors whose row is gone. Imported ONLY by worker.module.ts —
 * in AppModule it would make the API process consume retain jobs.
 */
@Module({
  imports: [PrismaModule, GraphModule, MemoryCoreModule, MemoryQueueModule],
  providers: [MemoryProcessor, MemoryReapSweeper],
})
export class MemoryWorkerModule {}
