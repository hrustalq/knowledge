import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { SearchCoreModule } from '../search/search-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventsSubscriberModule } from '../events/events-subscriber.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { WorkflowCoreModule } from './workflow-core.module.js';
import { WorkflowExecutors } from './workflow.executors.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { WorkflowProcessor } from './workflow.processor.js';
import { WorkflowSweeper } from './workflow.sweeper.js';
import { WorkflowTriggerService } from './workflow-trigger.service.js';

/**
 * Consumer side (docs/features/17) — imported ONLY by the worker entrypoint,
 * exactly like `IngestionWorkerModule`. Loading it into `AppModule` would make
 * the API process start executing workflow steps.
 *
 * Every import here is a Core half, chosen so nothing controller-bearing loads:
 * `EventsSubscriberModule` rather than `EventsApiModule` (which carries the SSE
 * controller and the WS gateway), `AssistantClientModule` rather than
 * `AssistantModule` (which pulls in `DocumentsModule`), and the `*CoreModule`
 * halves of activity and search rather than the modules that own their
 * controllers — importing those mapped `GET /v1/activity` and `POST /v1/search`
 * inside a process with no HTTP server and no guard to enforce their `@Access`.
 *
 * `DocumentsModule` is deliberately absent — it does not load here (its
 * `MergeRequestsService` needs `AccessService` from the global auth module),
 * which is what puts materialisation on the API side.
 */
@Module({
  imports: [
    AgentCoreModule,
    PrismaModule,
    ActivityCoreModule,
    StorageModule,
    SearchCoreModule,
    EventsModule,
    EventsSubscriberModule,
    AiCoreModule,
    // AccessService without the guards, so a node runs its owner's role
    // through the same check an HTTP request does (docs/features/20).
    AuthCoreModule,
    AssistantClientModule,
    WorkflowCoreModule,
  ],
  providers: [
    WorkflowExecutors,
    WorkflowProcessor,
    WorkflowSweeper,
    WorkflowTriggerService,
  ],
})
export class WorkflowWorkerModule {}
