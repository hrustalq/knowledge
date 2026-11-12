import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MemoryReapSweeper } from './memory-reap.sweeper.js';

/** Memory banks (#986), the worker's half: the reap of vectors whose row is gone. Worker-only. */
@Module({
  imports: [PrismaModule, GraphModule],
  providers: [MemoryReapSweeper],
})
export class MemoryWorkerModule {}
