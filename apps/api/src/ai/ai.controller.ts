import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type {
  AiConnectionTestResponse,
  AiPluginSummary,
  AiPluginTestResponse,
  AiProviderSummary,
  AiSettingsResponse,
  AiSkillSummary,
  ListAiPluginsResponse,
  ListAiProviderChoicesResponse,
  ListAiProvidersResponse,
  ListAiSkillsResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { AiPluginsService } from './ai-plugins.service.js';
import { AiProvidersService } from './ai-providers.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AiSkillsService } from './ai-skills.service.js';
import {
  CreateAiPluginDto,
  CreateAiProviderDto,
  CreateAiSkillDto,
  TestAiConnectionDto,
  UpdateAiPluginDto,
  UpdateAiProviderDto,
  UpdateAiSettingsDto,
  UpdateAiSkillDto,
} from './ai.dto.js';

/**
 * AI settings surface (docs/features/12): provider configuration, skills and
 * MCP plugins. Everything here is workspace-admin except reading the skill
 * roster, which the chat composer's skill picker needs for any member.
 */
@ApiTags('ai')
@Controller('v1/ai')
export class AiController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly skills: AiSkillsService,
    private readonly plugins: AiPluginsService,
    private readonly providers: AiProvidersService,
    private readonly aiConfig: AiConfigService,
    private readonly activity: ActivityService,
  ) {}

  // ---- Settings ------------------------------------------------------------

  @Get('settings')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Effective assistant configuration (DB overrides ∪ env). Never returns the API key.' })
  getSettings(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<AiSettingsResponse> {
    return this.settings.get(workspaceId);
  }

  @Patch('settings')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Update the workspace assistant config. Omitted fields keep, null clears (inherit env).' })
  async updateSettings(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiSettingsResponse> {
    const { workspaceId, ...input } = dto;
    const updated = await this.settings.update(workspaceId, input, principal?.userId);
    await this.activity.record({
      workspaceId,
      actor: principal?.userId,
      action: 'ai.settings.updated',
      // Never log the key itself — only which knobs moved.
      metadata: { fields: Object.keys(input).filter((k) => k !== 'apiKey') },
    });
    return updated;
  }

  @Post('settings/test')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'One tiny completion against the effective config — reports the upstream error verbatim' })
  async testConnection(
    @Body() dto: TestAiConnectionDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiConnectionTestResponse> {
    const result = await this.settings.test(dto.workspaceId, principal?.userId, dto.providerId);
    // A profile's row carries its own health, so the list can show it later.
    if (dto.providerId) await this.providers.recordCheck(dto.providerId, result.ok, result.error);
    return result;
  }

  // ---- Provider profiles ---------------------------------------------------

  @Get('providers')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Provider profiles (admin — rows carry endpoints and credential metadata)' })
  async listProviders(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListAiProvidersResponse> {
    return { providers: await this.providers.list(workspaceId) };
  }

  @Get('providers/choices')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({
    summary: 'Names and models a member may pick for their chat thread — no endpoints or credentials',
  })
  async listProviderChoices(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<ListAiProviderChoicesResponse> {
    const [rows, settings] = await Promise.all([
      this.providers.enabledProviders(workspaceId),
      this.settings.get(workspaceId).catch(() => null),
    ]);
    return {
      providers: rows.map((p) => ({ id: p.id, name: p.name, model: p.model })),
      defaultProviderId: settings?.routing.chat ?? null,
    };
  }

  @Post('providers')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Add a provider profile' })
  async createProvider(
    @Body() dto: CreateAiProviderDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiProviderSummary> {
    const { workspaceId, ...input } = dto;
    const provider = await this.providers.create(workspaceId, input, principal?.userId);
    await this.activity.record({
      workspaceId,
      actor: principal?.userId,
      action: 'ai.provider.created',
      subjectId: provider.id,
      metadata: { name: provider.name, model: provider.model },
    });
    return provider;
  }

  @Patch('providers/:id')
  @Access('admin', 'ai-provider')
  @ApiOperation({ summary: 'Update a profile. Omit apiKey to keep the stored credential; null clears it.' })
  async updateProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiProviderDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiProviderSummary> {
    const provider = await this.providers.update(id, dto);
    this.aiConfig.invalidate(provider.workspaceId);
    await this.activity.record({
      workspaceId: provider.workspaceId,
      actor: principal?.userId,
      action: 'ai.provider.updated',
      subjectId: provider.id,
      metadata: { name: provider.name },
    });
    return provider;
  }

  @Delete('providers/:id')
  @Access('admin', 'ai-provider')
  @ApiOperation({ summary: 'Delete a profile, clearing every route and thread pinned to it' })
  async deleteProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ ok: true }> {
    const provider = await this.providers.get(id);
    await this.providers.remove(id);
    this.aiConfig.invalidate(provider.workspaceId);
    await this.activity.record({
      workspaceId: provider.workspaceId,
      actor: principal?.userId,
      action: 'ai.provider.deleted',
      subjectId: id,
      metadata: { name: provider.name },
    });
    return { ok: true };
  }

  // ---- Skills --------------------------------------------------------------

  @Get('skills')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Skills in the workspace (viewer — the chat composer offers them)' })
  async listSkills(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListAiSkillsResponse> {
    return { skills: await this.skills.list(workspaceId) };
  }

  @Post('skills')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Create a skill' })
  async createSkill(
    @Body() dto: CreateAiSkillDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiSkillSummary> {
    const { workspaceId, ...input } = dto;
    const skill = await this.skills.create(workspaceId, input, principal?.userId);
    await this.activity.record({
      workspaceId,
      actor: principal?.userId,
      action: 'ai.skill.created',
      subjectId: skill.id,
      metadata: { name: skill.name },
    });
    return skill;
  }

  @Get('skills/:id')
  @Access('viewer', 'ai-skill')
  @ApiOperation({ summary: 'One skill' })
  getSkill(@Param('id', ParseUUIDPipe) id: string): Promise<AiSkillSummary> {
    return this.skills.get(id);
  }

  @Patch('skills/:id')
  @Access('admin', 'ai-skill')
  @ApiOperation({ summary: 'Update a skill' })
  async updateSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiSkillDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiSkillSummary> {
    const skill = await this.skills.update(id, dto);
    await this.activity.record({
      workspaceId: skill.workspaceId,
      actor: principal?.userId,
      action: 'ai.skill.updated',
      subjectId: skill.id,
      metadata: { name: skill.name },
    });
    return skill;
  }

  @Delete('skills/:id')
  @Access('admin', 'ai-skill')
  @ApiOperation({ summary: 'Delete a skill' })
  async deleteSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ ok: true }> {
    const skill = await this.skills.get(id);
    await this.skills.remove(id);
    await this.activity.record({
      workspaceId: skill.workspaceId,
      actor: principal?.userId,
      action: 'ai.skill.deleted',
      subjectId: id,
      metadata: { name: skill.name },
    });
    return { ok: true };
  }

  // ---- Plugins (MCP servers) ----------------------------------------------

  @Get('plugins')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'MCP plugins in the workspace (admin — rows carry endpoints and credential metadata)' })
  async listPlugins(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListAiPluginsResponse> {
    return { plugins: await this.plugins.list(workspaceId) };
  }

  @Post('plugins')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Register an MCP server and discover its tools' })
  async createPlugin(
    @Body() dto: CreateAiPluginDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiPluginSummary> {
    const { workspaceId, ...input } = dto;
    const plugin = await this.plugins.create(workspaceId, input, principal?.userId);
    await this.activity.record({
      workspaceId,
      actor: principal?.userId,
      action: 'ai.plugin.created',
      subjectId: plugin.id,
      metadata: { name: plugin.name, url: plugin.url },
    });
    return plugin;
  }

  @Patch('plugins/:id')
  @Access('admin', 'ai-plugin')
  @ApiOperation({ summary: 'Update a plugin. Omit authValue to keep the stored credential; null clears it.' })
  async updatePlugin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiPluginDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiPluginSummary> {
    const plugin = await this.plugins.update(id, dto);
    await this.activity.record({
      workspaceId: plugin.workspaceId,
      actor: principal?.userId,
      action: 'ai.plugin.updated',
      subjectId: plugin.id,
      metadata: { name: plugin.name },
    });
    return plugin;
  }

  @Delete('plugins/:id')
  @Access('admin', 'ai-plugin')
  @ApiOperation({ summary: 'Delete a plugin' })
  async deletePlugin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ ok: true }> {
    const plugin = await this.plugins.get(id);
    await this.plugins.remove(id);
    await this.activity.record({
      workspaceId: plugin.workspaceId,
      actor: principal?.userId,
      action: 'ai.plugin.deleted',
      subjectId: id,
      metadata: { name: plugin.name },
    });
    return { ok: true };
  }

  @Post('plugins/:id/test')
  @Access('admin', 'ai-plugin')
  @ApiOperation({ summary: 'Reconnect and re-discover the plugin tool list' })
  testPlugin(@Param('id', ParseUUIDPipe) id: string): Promise<AiPluginTestResponse> {
    return this.plugins.test(id);
  }
}
