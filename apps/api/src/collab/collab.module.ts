import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventsSubscriberModule } from '../events/events-subscriber.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { CollabController, CollabDraftsController } from './collab.controller.js';
import { CollabCheckpointSweeper } from './collab-checkpoint.sweeper.js';
import { CollabDraftToolsService } from './collab-draft-tools.service.js';
import { CollabDraftsService } from './collab-drafts.service.js';
import { CollabGateway } from './collab.gateway.js';

/**
 * Real-time co-editing of drafts (#80, docs/features/56). API-only, like
 * EventsApiModule: it holds a gateway and a controller, so the worker and
 * the stdio MCP server never import it; `McpHttpModule`, which runs in the
 * API, does, for the draft tools. AuthModule is global, so TokenAuthService
 * resolves without an import.
 */
@Module({
  imports: [DocumentsCoreModule, PermissionsCoreModule, EventsModule, EventsSubscriberModule, StorageModule],
  controllers: [CollabController, CollabDraftsController],
  providers: [CollabDraftsService, CollabGateway, CollabCheckpointSweeper, CollabDraftToolsService],
  // The MCP draft tools (#316), for the API's HTTP MCP only: the stdio server never loads this module.
  exports: [CollabDraftToolsService],
})
export class CollabModule {}
