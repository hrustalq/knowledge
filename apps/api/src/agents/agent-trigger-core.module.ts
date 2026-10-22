import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { AgentCoreModule } from './agent-core.module.js';
import { AgentQueueModule } from './agent-queue.module.js';
import { AgentTriggerService } from './agent-trigger.service.js';

/**
 * `AgentTriggerService` (#70), controller-free so either process can fire a
 * trigger: the worker's bus listener, and on the API side a signed webhook
 * delivery (`AgentWebhookController`) and an @mention (`MentionRepliesService`).
 * The listener half is `AgentTriggerListener`, in `AgentWorkerModule` only.
 */
@Module({
  imports: [PrismaModule, AiCoreModule, ActivityCoreModule, AuthCoreModule, PermissionsCoreModule, AgentCoreModule, AgentQueueModule],
  providers: [AgentTriggerService],
  exports: [AgentTriggerService],
})
export class AgentTriggerCoreModule {}
