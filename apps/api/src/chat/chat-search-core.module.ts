import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ChatSearchService } from './chat-search.service.js';

/**
 * Chat search (#339) without a controller, so the MCP server and the
 * assistant's read tools can import it as well as ChatModule's REST route.
 */
@Module({
  imports: [PrismaModule, GraphModule, EmbeddingModule],
  providers: [ChatSearchService],
  exports: [ChatSearchService],
})
export class ChatSearchCoreModule {}
