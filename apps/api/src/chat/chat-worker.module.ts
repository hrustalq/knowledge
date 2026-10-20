import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ChatIndexSweeper } from './chat-index.sweeper.js';

/**
 * The worker half of searchable chat (#339) — imported ONLY by
 * worker.module.ts. Indexing needs embeddings and the graph and attributes
 * nothing to anyone, so it is the worker's; ChatModule stays API-only.
 */
@Module({
  imports: [PrismaModule, GraphModule, EmbeddingModule],
  providers: [ChatIndexSweeper],
})
export class ChatWorkerModule {}
