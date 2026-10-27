import { Module } from '@nestjs/common';
import { HarvestCoreModule } from '../chat/harvest-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { ConnectorHarvestSweeper } from './harvest/connector-harvest.sweeper.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventsSubscriberModule } from '../events/events-subscriber.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ConnectorConflictSweeper } from './connector-conflict.sweeper.js';
import { ConnectionsBackfill } from './connections.backfill.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { ConnectorItemAiService } from './connector-item-ai.service.js';
import { ConnectorItemsService } from './connector-items.service.js';
import { ConnectorQueueModule } from './connector-queue.module.js';
import { ConnectorWebhookController } from './connector-webhook.controller.js';
import { ConnectorWorkItemsModule } from './connector-work-items.module.js';
import { WorkItemHandoffModule } from './handoff/work-item-handoff.module.js';
import { WorkItemsController } from './handoff/work-items.controller.js';
import { WorkItemSyncSweeper } from './handoff/work-item-sync.sweeper.js';
import { TrackerRoutesController } from './handoff/tracker-routes.controller.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ConnectorsCoreModule } from './connectors-core.module.js';
import { ConnectorsController } from './connectors.controller.js';
import { GithubBrowseService } from './github/github-browse.service.js';
import { GithubCoreModule } from './github/github-core.module.js';
import { GithubOauthService } from './github/github-oauth.service.js';
import { GithubController } from './github/github.controller.js';
import { GithubWebhookController } from './github/github-webhook.controller.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { DriftTriggerService } from './drift/drift-trigger.service.js';
import { GithubAccessService } from './github/github-access.service.js';
import { RepoGuidanceListener } from './guidance/repo-guidance.listener.js';
import { RepoGuidanceService } from './guidance/repo-guidance.service.js';

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
    WorkItemHandoffModule,
    PermissionsCoreModule,
    ConnectorQueueModule,
    ActivityModule,
    DocumentsModule,
    ProjectsModule,
    StorageModule,
    EventsModule,
    AgentCoreModule,
    // Producer only: a pull or merge request queues a drift check
    // (docs/features/35); the executor is the worker's.
    AgentQueueModule,
    AiCoreModule,
    AssistantClientModule,
    GithubCoreModule,
    // The repo guidance listener (#70) — API-side, so the shared subscriber.
    EventsSubscriberModule,
    HarvestCoreModule,
    NotificationsCoreModule,
  ],
  // GithubWebhookController comes FIRST, before ConnectorWebhookController:
  // `/v1/connectors/github/webhook` and `/v1/connectors/:id/webhook` have the
  // same segment count, so the per-connector route would otherwise claim it and
  // ParseUuidPipe would 400 on the literal `github`. The three picker GETs on
  // GithubController need no such care — they are one segment longer than
  // anything `:id` declares.
  controllers: [
    GithubWebhookController,
    ConnectorsController,
    ConnectorWebhookController,
    GithubController,
    WorkItemsController,
    TrackerRoutesController,
    // #564: workspace connections and the link screen.
    ConnectionsController,
  ],
  providers: [
    ConnectorConflictSweeper,
    // #424: API-only, here rather than in WorkItemHandoffModule (which MCP imports).
    WorkItemSyncSweeper,
    // #382: API-only for the same reason — a harvest is attributed to the person who resolved the item.
    ConnectorHarvestSweeper,
    ConnectorItemsService,
    ConnectorItemAiService,
    // API-only: both exist to serve a person clicking through the picker.
    GithubOauthService,
    GithubBrowseService,
    // The connector page's GitHub access card (docs/features/36).
    GithubAccessService,
    // Both webhook controllers hand pull and merge requests to it.
    DriftTriggerService,
    // Guidance files into disabled skills (#70): configuration attributed to a
    // person, so API-side — the manual route and the after-sync listener.
    RepoGuidanceService,
    RepoGuidanceListener,
    // #564: binds existing connectors to connections once per boot, in one process.
    ConnectionsBackfill,
    ConnectionsService,
  ],
  exports: [ConnectorsCoreModule, ConnectorWorkItemsModule],
})
export class ConnectorsModule {}
