import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from './assistant-client.module.js';
import { StyleLintService } from './style-lint.service.js';

/**
 * The styleguide check on its own (#74, phase 5): controller-free, so the MCP
 * tool set can import it without AssistantModule's controller and chat
 * surface. AssistantModule imports it for `POST /v1/assistant/lint`.
 */
@Module({
  imports: [AgentCoreModule, AiCoreModule, AssistantClientModule],
  providers: [StyleLintService],
  exports: [StyleLintService],
})
export class StyleLintModule {}
