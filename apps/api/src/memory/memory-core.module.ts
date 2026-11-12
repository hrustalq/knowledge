import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { DecisionClientModule } from '../assistant/decision-client.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { MemoryOperationsService } from './memory-operations.service.js';
import { MemoryQueueModule } from './memory-queue.module.js';
import { MemoryRecallService } from './memory-recall.service.js';
import { MemoryRetainService } from './memory-retain.service.js';
import { MemoryUnitsService } from './memory-units.service.js';

/**
 * Memory banks (#986), the controller-free half: the request resolver and the
 * services behind the Hindsight-shaped routes. Loadable by every process —
 * the worker retains through the same `MemoryRetainService` the API does.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, PermissionsCoreModule, GraphModule, EmbeddingModule, AgentCoreModule, AiCoreModule, AssistantClientModule, DecisionClientModule, MemoryQueueModule],
  providers: [MemoryAccessService, MemoryBanksService, MemoryOperationsService, MemoryRecallService, MemoryRetainService, MemoryUnitsService],
  exports: [MemoryAccessService, MemoryBanksService, MemoryOperationsService, MemoryRecallService, MemoryRetainService, MemoryUnitsService],
})
export class MemoryCoreModule {}
