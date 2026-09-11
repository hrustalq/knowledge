import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { EventsModule } from '../events/events.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ConnectorConflictSweeper } from './connector-conflict.sweeper.js';
import { ConnectorItemAiService } from './connector-item-ai.service.js';
import { ConnectorItemsService } from './connector-items.service.js';
import { ConnectorQueueModule } from './connector-queue.module.js';
import { ConnectorWebhookController } from './connector-webhook.controller.js';
import { ConnectorsCoreModule } from './connectors-core.module.js';
import { ConnectorsController } from './connectors.controller.js';

/**
 * API side (docs/features/19). Holds the controllers and the conflict sweeper,
 * which needs MergeRequestsService and therefore AccessService — the reason it
 * cannot live in the worker.
 *
 * The review services (docs/features/26) belong here for the same reason plus
 * one of their own: approving and reverting are somebody's acts, attributed to
 * them, and revert can delete a page. Neither is a thing an unattended worker
 * should be able to do. The three AI modules are the controller-free splits, so
 * none of this reaches back into the worker.
 */
@Module({
  imports: [
    ConnectorsCoreModule,
    ConnectorQueueModule,
    ActivityModule,
    DocumentsModule,
    ProjectsModule,
    StorageModule,
    EventsModule,
    AgentCoreModule,
    AiCoreModule,
    AssistantClientModule,
  ],
  controllers: [ConnectorsController, ConnectorWebhookController],
  providers: [ConnectorConflictSweeper, ConnectorItemsService, ConnectorItemAiService],
  exports: [ConnectorsCoreModule],
})
export class ConnectorsModule {}
