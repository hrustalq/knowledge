import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { GroupsService } from './groups.service.js';
import { PermissionService } from './permission.service.js';
import { ResourceAccessService } from './resource-access.service.js';
import { AclEventsService } from './acl-events.service.js';
import { AccessRequestsService } from './access-requests.service.js';
import { EventsModule } from '../events/events.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';

/**
 * Controller-free half of page permissions (#76), loadable by every process.
 *
 * The visibility predicate (`PermissionService`) lives here rather than beside
 * the controllers because the worker (agents, ACL sync) and the MCP process
 * must ask the very same question an HTTP request does — a weakened copy in
 * either is a leak.
 */
@Module({
  // EventsModule and NotificationsCoreModule: an ACL change is announced
  // (`acl.changed`), and access requests notify managers and requesters. No
  // cycle — the notifications side reads permissions through the plain
  // functions in acl-read.ts, never through this module.
  imports: [PrismaModule, AuthCoreModule, EventsModule, NotificationsCoreModule],
  providers: [GroupsService, PermissionService, ResourceAccessService, AclEventsService, AccessRequestsService],
  exports: [GroupsService, PermissionService, ResourceAccessService, AclEventsService, AccessRequestsService],
})
export class PermissionsCoreModule {}
