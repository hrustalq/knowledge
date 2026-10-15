import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { GroupsService } from './groups.service.js';

/**
 * Controller-free half of page permissions (#76), loadable by every process.
 *
 * Today it holds groups alone. The visibility predicate joins it next, and it
 * has to live here rather than beside the controllers because the worker
 * (agents, ACL sync) and the MCP process must ask the very same question an
 * HTTP request does — a weakened copy in either is a leak.
 */
@Module({
  imports: [PrismaModule],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class PermissionsCoreModule {}
