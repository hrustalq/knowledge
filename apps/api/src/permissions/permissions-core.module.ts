import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { GroupsService } from './groups.service.js';
import { PermissionService } from './permission.service.js';
import { ResourceAccessService } from './resource-access.service.js';

/**
 * Controller-free half of page permissions (#76), loadable by every process.
 *
 * The visibility predicate (`PermissionService`) lives here rather than beside
 * the controllers because the worker (agents, ACL sync) and the MCP process
 * must ask the very same question an HTTP request does — a weakened copy in
 * either is a leak.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule],
  providers: [GroupsService, PermissionService, ResourceAccessService],
  exports: [GroupsService, PermissionService, ResourceAccessService],
})
export class PermissionsCoreModule {}
