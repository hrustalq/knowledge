import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { EventsSubscriberModule } from '../events/events-subscriber.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { CollabController } from './collab.controller.js';
import { CollabDraftsService } from './collab-drafts.service.js';
import { CollabGateway } from './collab.gateway.js';

/**
 * Real-time co-editing of drafts (#80, docs/features/56). API-only, like
 * EventsApiModule: it holds a gateway and a controller, so worker and MCP
 * never import it. AuthModule is global, so TokenAuthService resolves
 * without an import.
 */
@Module({
  imports: [DocumentsCoreModule, PermissionsCoreModule, EventsSubscriberModule],
  controllers: [CollabController],
  providers: [CollabDraftsService, CollabGateway],
})
export class CollabModule {}
