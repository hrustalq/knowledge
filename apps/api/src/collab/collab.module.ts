import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { CollabDraftsService } from './collab-drafts.service.js';
import { CollabGateway } from './collab.gateway.js';

/**
 * Real-time co-editing of drafts (#80, docs/features/56). API-only, like
 * EventsApiModule: it holds a gateway, so worker and MCP never import it.
 * AuthModule is global, so TokenAuthService resolves without an import.
 */
@Module({
  imports: [DocumentsCoreModule, PermissionsCoreModule],
  providers: [CollabDraftsService, CollabGateway],
})
export class CollabModule {}
