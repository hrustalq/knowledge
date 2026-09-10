import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { DocumentsCoreModule } from './documents-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { GlossaryCoreModule } from '../glossary/glossary-core.module.js';
import { DocumentsController } from './documents.controller.js';
import { CompareService } from './compare.service.js';
import { MergeRequestsController } from './merge-requests.controller.js';
import { MergeRequestsService } from './merge-requests.service.js';
import { MergeRequestThreadsService } from './merge-request-threads.service.js';
import { SavedFiltersService } from './saved-filters.service.js';
import { DocumentThreadsService } from './document-threads.service.js';
import { HistoryService } from './history.service.js';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { ConnectorQueueModule } from '../connectors/connector-queue.module.js';
import { EventsModule } from '../events/events.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { MentionRepliesService } from './mention-replies.service.js';
import { MentionReplySweeper } from './mention-reply.sweeper.js';

/**
 * API side. DocumentsService itself lives in DocumentsCoreModule (worker-safe);
 * everything here needs either a controller or AccessService, so it stays out
 * of WorkerModule.
 */
@Module({
  imports: [
    DocumentsCoreModule,
    ActivityModule,
    StorageModule,
    GraphModule,
    IngestionModule,
    ProjectsModule,
    // The page-side connector surface (docs/features/19): 'linked to' and 'push now'.
    ConnectorsCoreModule,
    ConnectorQueueModule,
    // Agent mentions in review discussions (docs/features/21). All three are
    // Core/Client splits with no controllers and no reach for AccessService, so
    // none of them imports DocumentsModule back — which is what lets a mention
    // reply live here instead of behind a forwardRef.
    AgentCoreModule,
    AiCoreModule,
    EventsModule,
    AssistantClientModule,
    // Review notifications: mentions, assignee, review requests (docs/features/22).
    NotificationsCoreModule,
    // Per-occurrence glossary exclusions (docs/features/14) hang off the
    // document routes, so the controller needs GlossaryService. Core-only, and
    // GlossaryCoreModule reaches for DocumentsCoreModule rather than this
    // module, so there is no cycle.
    GlossaryCoreModule,
  ],
  controllers: [DocumentsController, MergeRequestsController],
  providers: [
    CompareService,
    MergeRequestsService,
    MergeRequestThreadsService,
    SavedFiltersService,
    DocumentThreadsService,
    HistoryService,
    MentionRepliesService,
    MentionReplySweeper,
  ],
  exports: [
    DocumentsCoreModule,
    CompareService,
    MergeRequestsService,
    MergeRequestThreadsService,
    DocumentThreadsService,
    HistoryService,
  ],
})
export class DocumentsModule {}
