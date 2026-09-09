import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { SearchModule } from '../search/search.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventsSubscriber } from '../events/events.subscriber.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClient } from '../assistant/assistant.client.js';
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
 * `EventsSubscriber` and `AssistantClient` are provided directly rather than by
 * importing the modules that own them. Each needs almost nothing —
 * `EventsSubscriber` wants Redis, `AssistantClient` wants `AiUsageService` from
 * `AiCoreModule` — while `EventsApiModule` also carries the SSE controller and
 * the WS gateway, and `AssistantModule` pulls in `DocumentsModule`, neither of
 * which will load here.
 *
 * `DocumentsModule` is deliberately absent — it does not load here (its
 * `MergeRequestsService` needs `AccessService` from the global auth module),
 * which is what puts materialisation on the API side.
 */
@Module({
  imports: [AgentCoreModule, 
    PrismaModule,
    ActivityModule,
    StorageModule,
    SearchModule,
    EventsModule,
    AiCoreModule,
    WorkflowCoreModule,
  ],
  providers: [
    EventsSubscriber,
    AssistantClient,
    WorkflowExecutors,
    WorkflowProcessor,
    WorkflowSweeper,
    WorkflowTriggerService,
  ],
})
export class WorkflowWorkerModule {}
