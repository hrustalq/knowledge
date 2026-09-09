import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AiCoreModule } from './ai-core.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiPluginsService } from './ai-plugins.service.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AiAgentsService, AgentRunsService } from './ai-agents.service.js';
import { AgentFindingsService } from './agent-findings.service.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AgentTiebreakService } from './agent-tiebreak.service.js';
import { McpClientService } from './mcp-client.service.js';
import { AiController } from './ai.controller.js';
import { AiUsageController } from './ai-usage.controller.js';

/**
 * AI settings (docs/features/12). API-only module — keep it out of worker and
 * MCP contexts (same rationale as GraphQueryModule): the controllers depend on
 * the global auth guards.
 *
 * The circular import with AssistantModule is real and deliberate: the
 * assistant needs config/usage/skills/plugins to run a turn, and the settings
 * page needs AssistantClient to run its "Test connection" completion against
 * the config it just saved. forwardRef on both sides keeps that one shared
 * client rather than duplicating the SDK wiring.
 */
@Module({
  imports: [
    PrismaModule,
    AiCoreModule,
    AgentCoreModule,
    AgentQueueModule,
    ActivityModule,
    // Turning a finding into a merge request writes a branch, a revision and an
    // MR — the API half of feature 17's "the worker generates, the API
    // publishes". DocumentsModule does not import this one, so no new cycle.
    DocumentsModule,
    StorageModule,
    forwardRef(() => AssistantModule),
  ],
  controllers: [AiController, AiUsageController],
  providers: [AiAgentsService, AgentRunsService, AgentFindingsService, AgentTiebreakService, AiPluginsService, AiSettingsService, McpClientService],
  exports: [AiCoreModule, AgentCoreModule, AiPluginsService, AgentTiebreakService],
})
export class AiModule {}
