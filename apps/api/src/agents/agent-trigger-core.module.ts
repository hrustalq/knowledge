import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { AgentCoreModule } from './agent-core.module.js';
import { AgentQueueModule } from './agent-queue.module.js';
import { AgentTriggerService } from './agent-trigger.service.js';

/**
 * `AgentTriggerService` (#70), controller-free so either process can fire a
 * trigger: the worker's bus listener today, an inline webhook delivery on the
 * API side next. The listener half is `AgentTriggerListener`, in
 * `AgentWorkerModule` only.
 */
@Module({
  imports: [PrismaModule, AiCoreModule, ActivityCoreModule, AgentCoreModule, AgentQueueModule],
  providers: [AgentTriggerService],
  exports: [AgentTriggerService],
})
export class AgentTriggerCoreModule {}
