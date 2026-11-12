import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { PurposeInterviewController } from './purpose-interview.controller.js';
import { PurposeInterviewService } from './purpose-interview.service.js';

/**
 * The workspace purpose interview (#934). API-only, and a module of its own
 * so the workspaces module does not come to import the assistant's.
 */
@Module({
  imports: [AgentCoreModule, AiCoreModule, AssistantClientModule],
  controllers: [PurposeInterviewController],
  providers: [PurposeInterviewService],
})
export class WorkspacePurposeModule {}
