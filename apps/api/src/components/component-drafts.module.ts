import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ComponentDraftsService } from './component-drafts.service.js';
import { ComponentsCoreModule } from './components-core.module.js';

/**
 * "Document this component" (#236, phase 5): queuing the draft. Controller-free
 * so the MCP tool shares it with the REST route; it only writes the run row
 * and enqueues it, so it needs nothing API-only. The publishing half — the
 * sweeper that opens the merge request — is in `ComponentsModule`.
 */
@Module({
  imports: [PrismaModule, AgentCoreModule, AgentQueueModule, AiCoreModule, ComponentsCoreModule, PermissionsCoreModule],
  providers: [ComponentDraftsService],
  exports: [ComponentDraftsService],
})
export class ComponentDraftsModule {}
