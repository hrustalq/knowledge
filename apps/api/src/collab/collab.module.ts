import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventsSubscriberModule } from '../events/events-subscriber.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { CollabController, CollabDraftsController } from './collab.controller.js';
import { CollabCheckpointSweeper } from './collab-checkpoint.sweeper.js';
import { CollabDraftsService } from './collab-drafts.service.js';
import { CollabGateway } from './collab.gateway.js';

/**
 * Real-time co-editing of drafts (#80, docs/features/56). API-only, like
 * EventsApiModule: it holds a gateway and a controller, so worker and MCP
 * never import it. AuthModule is global, so TokenAuthService resolves
 * without an import.
 */
@Module({
  imports: [DocumentsCoreModule, PermissionsCoreModule, EventsModule, EventsSubscriberModule, StorageModule],
  controllers: [CollabController, CollabDraftsController],
  providers: [CollabDraftsService, CollabGateway, CollabCheckpointSweeper],
})
export class CollabModule {}
