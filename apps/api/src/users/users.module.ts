import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MailQueueModule } from '../mail/mail-queue.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/**
 * Users management (platform admin). API-only module — keep it out of worker
 * and MCP contexts (same rationale as GraphQueryModule): the controller
 * depends on the global auth guards.
 */
@Module({
  imports: [PrismaModule, MailQueueModule, PermissionsCoreModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
