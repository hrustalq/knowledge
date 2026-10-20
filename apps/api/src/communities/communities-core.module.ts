import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CommunitiesService } from './communities.service.js';

/** Communities as readers get them (#81). Controller-free: the assistant, MCP and documents read it. */
@Module({
  imports: [PrismaModule, GraphModule, EmbeddingModule],
  providers: [CommunitiesService],
  exports: [CommunitiesService],
})
export class CommunitiesCoreModule {}
