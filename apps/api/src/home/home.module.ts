import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { VerificationCoreModule } from '../verification/verification-core.module.js';
import { MergeRequestsCoreModule } from '../documents/merge-requests-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { AnalyticsCoreModule } from '../analytics/analytics-core.module.js';
import { AiModule } from '../ai/ai.module.js';
import { HomeController } from './home.controller.js';
import { HomeService } from './home.service.js';

/** The workspace home (#1243). API-only: a controller, and every read it composes belongs to another module. */
@Module({
  // AiModule for AgentRunsService, which lives beside its controller.
  imports: [
    PrismaModule,
    AuthCoreModule,
    PermissionsCoreModule,
    ActivityCoreModule,
    VerificationCoreModule,
    MergeRequestsCoreModule,
    NotificationsCoreModule,
    AnalyticsCoreModule,
    AiModule,
  ],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
