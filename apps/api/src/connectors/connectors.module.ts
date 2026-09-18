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
import { ConnectorWorkItemsModule } from './connector-work-items.module.js';
import { ConnectorsCoreModule } from './connectors-core.module.js';
import { ConnectorsController } from './connectors.controller.js';
import { GithubBrowseService } from './github/github-browse.service.js';
import { GithubCoreModule } from './github/github-core.module.js';
import { GithubOauthService } from './github/github-oauth.service.js';
import { GithubController } from './github/github.controller.js';
import { GithubWebhookController } from './github/github-webhook.controller.js';

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
    ConnectorWorkItemsModule,
    ConnectorQueueModule,
    ActivityModule,
    DocumentsModule,
    ProjectsModule,
    StorageModule,
    EventsModule,
    AgentCoreModule,
    AiCoreModule,
    AssistantClientModule,
    GithubCoreModule,
  ],
  // GithubWebhookController comes FIRST, before ConnectorWebhookController:
  // `/v1/connectors/github/webhook` and `/v1/connectors/:id/webhook` have the
  // same segment count, so the per-connector route would otherwise claim it and
  // ParseUuidPipe would 400 on the literal `github`. The three picker GETs on
  // GithubController need no such care — they are one segment longer than
  // anything `:id` declares.
  controllers: [GithubWebhookController, ConnectorsController, ConnectorWebhookController, GithubController],
  providers: [
    ConnectorConflictSweeper,
    ConnectorItemsService,
    ConnectorItemAiService,
    // API-only: both exist to serve a person clicking through the picker.
    GithubOauthService,
    GithubBrowseService,
  ],
  exports: [ConnectorsCoreModule, ConnectorWorkItemsModule],
})
export class ConnectorsModule {}
