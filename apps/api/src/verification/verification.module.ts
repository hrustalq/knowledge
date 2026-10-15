import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { KnowledgeHealthController } from './knowledge-health.controller.js';
import { VerificationController } from './verification.controller.js';
import { VerificationCoreModule } from './verification-core.module.js';
import { VerificationSweeper } from './verification.sweeper.js';

/**
 * API side: the page routes and the knowledge-health routes over
 * VerificationCoreModule, plus the expiry sweeper — API-only because a
 * reminder is a user-facing act ("the worker generates, the API publishes").
 */
@Module({
  imports: [VerificationCoreModule, PrismaModule, ActivityCoreModule, NotificationsCoreModule, StorageModule, PermissionsCoreModule],
  controllers: [VerificationController, KnowledgeHealthController],
  providers: [VerificationSweeper],
  exports: [VerificationCoreModule],
})
export class VerificationModule {}
