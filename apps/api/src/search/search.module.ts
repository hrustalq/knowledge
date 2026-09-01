import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [GraphModule, EmbeddingModule, FulltextModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
