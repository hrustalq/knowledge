import { ConflictsCoreModule } from '../conflicts/conflicts-core.module.js';
import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VerificationCoreModule } from '../verification/verification-core.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AiCoreModule } from './ai-core.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { GlossaryCoreModule } from '../glossary/glossary-core.module.js';
import { AiPluginsService } from './ai-plugins.service.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AiAgentsService, AgentRunsService } from './ai-agents.service.js';
import { AgentFindingsService } from './agent-findings.service.js';
import { AgentTriggersService } from './agent-triggers.service.js';
import { AgentRecipesService } from './agent-recipes.service.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AgentTriggerCoreModule } from '../agents/agent-trigger-core.module.js';
import { AgentWebhookController } from './agent-webhook.controller.js';
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
    // Propose links a finding's conflict to its merge request (#81).
    ConflictsCoreModule,
    AgentQueueModule,
    // A signed delivery fires its trigger inline (#70); controller-free.
    AgentTriggerCoreModule,
    ActivityModule,
    // Turning a finding into a merge request writes a branch, a revision and an
    // MR — the API half of feature 17's "the worker generates, the API
    // publishes". DocumentsModule does not import this one, so no new cycle.
    DocumentsModule,
    StorageModule,
    // Mark outdated from a finding (docs/features/39). Controller-free.
    VerificationCoreModule,
    // AgentFindingsService.addTerm writes through the one glossary writer (#74).
    GlossaryCoreModule,
    forwardRef(() => AssistantModule),
  ],
  controllers: [AiController, AiUsageController, AgentWebhookController],
  providers: [AiAgentsService, AgentRunsService, AgentTriggersService, AgentRecipesService, AgentFindingsService, AgentTiebreakService, AiPluginsService, AiSettingsService, McpClientService],
  // AgentFindingsService for the drift check's publisher (docs/features/35),
  // which proposes through the very path the Propose button takes.
  exports: [AiCoreModule, AgentCoreModule, AiPluginsService, AgentTiebreakService, AgentFindingsService],
})
export class AiModule {}
