import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { SearchService } from './search.service.js';

/**
 * Search with no controller, so worker contexts can import it.
 *
 * Same shape as `ActivityCoreModule` / `AiCoreModule`: the controller-bearing
 * `SearchModule` imports this and re-exports it, which keeps every existing
 * `imports: [SearchModule]` working unchanged.
 *
 * `WorkflowWorkerModule` needs `SearchService` for the `search` step kind, and
 * was importing `SearchModule` — which constructed `SearchController` and
 * mapped `POST /v1/search` inside the worker process, where there is no HTTP
 * server and no auth guard registered to enforce its `@Access`.
 */
@Module({
  imports: [GraphModule, EmbeddingModule, FulltextModule],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchCoreModule {}
