import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { FeedbackCoreModule } from '../feedback/feedback-core.module.js';
import { VerificationPolicyModule } from '../verification/verification-policy.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { TemporalCoreModule } from '../temporal/temporal-core.module.js';
import { AnalyticsCoreModule } from '../analytics/analytics-core.module.js';
import { CommunitiesCoreModule } from '../communities/communities-core.module.js';
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
  // FeedbackCoreModule for the open-report count and VerificationPolicyModule
  // for the trust switch and the inactivity window (docs/features/39): both
  // leaves, both worker-safe. PermissionsCoreModule for the caller's page
  // visibility (#76), controller-free by design. AnalyticsCoreModule records
  // each search (#79). CommunitiesCoreModule for the community prior and
  // each result's place in the tree (#475), a leaf over the stores.
  imports: [
    GraphModule,
    EmbeddingModule,
    FulltextModule,
    FeedbackCoreModule,
    VerificationPolicyModule,
    PermissionsCoreModule,
    TemporalCoreModule,
    AnalyticsCoreModule,
    CommunitiesCoreModule,
  ],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchCoreModule {}
