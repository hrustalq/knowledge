import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AgentRegistryService } from './agent-registry.service.js';
import { AgentRouterService } from './agent-router.service.js';

/**
 * Controller-free half of the agents layer (docs/features/20), imported by both
 * the API and the worker — the shape AiCoreModule has under AiModule.
 *
 * The split is load-bearing for the same reason it was for AI config: agents
 * resolve on background paths (relation extraction, import OCR, workflow steps)
 * that run in the worker, where the global AuthModule and every controller are
 * deliberately absent. Nothing in here may reach for AccessService.
 */
@Module({
  imports: [PrismaModule, AiCoreModule],
  providers: [AgentRegistryService, AgentRouterService],
  exports: [AgentRegistryService, AgentRouterService],
})
export class AgentCoreModule {}
