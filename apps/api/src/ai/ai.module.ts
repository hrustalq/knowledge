import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AiCoreModule } from './ai-core.module.js';
import { AiPluginsService } from './ai-plugins.service.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AiSkillsService } from './ai-skills.service.js';
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
  imports: [PrismaModule, AiCoreModule, ActivityModule, forwardRef(() => AssistantModule)],
  controllers: [AiController, AiUsageController],
  providers: [AiSkillsService, AiPluginsService, AiSettingsService, McpClientService],
  exports: [AiCoreModule, AiSkillsService, AiPluginsService],
})
export class AiModule {}
