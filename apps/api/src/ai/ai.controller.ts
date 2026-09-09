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
  AgentRouteDecision,
  AgentRunSummary,
  AiAgentSummary,
  ListAgentRunsResponse,
  ListAiAgentChoicesResponse,
  ListAiAgentsResponse,
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
import { AiAgentsService, AgentRunsService } from './ai-agents.service.js';
import { AgentRouterService } from '../agents/agent-router.service.js';
import { AgentTiebreakService } from './agent-tiebreak.service.js';
import {
  CreateAiAgentDto,
  CreateAiPluginDto,
  CreateAiProviderDto,
  CreateAiSkillDto,
  TestAiConnectionDto,
  UpdateAiPluginDto,
  UpdateAiProviderDto,
  UpdateAiSettingsDto,
  RouteAgentDto,
  StartAgentRunDto,
  UpdateAiAgentDto,
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
    private readonly agents: AiAgentsService,
    private readonly runs: AgentRunsService,
    private readonly router: AgentRouterService,
    private readonly tiebreak: AgentTiebreakService,
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

  // ---- Agents (docs/features/20) -------------------------------------------

  @Get('agents')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Effective agent roster: built-in defaults ∪ this workspace overrides' })
  async listAgents(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListAiAgentsResponse> {
    return { agents: await this.agents.list(workspaceId) };
  }

  // Declared before ':key' or the router would match "choices" as an agent key.
  @Get('agents/choices')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Agents offerable in the composer (viewer — names only, no prompts)' })
  async listAgentChoices(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<ListAiAgentChoicesResponse> {
    return { agents: await this.agents.choices(workspaceId) };
  }

  // Runs (background execution). Declared before ':key' so "runs" is not read
  // as an agent key.
  @Get('agents/runs')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'agentKey', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOperation({ summary: 'Background agent runs, newest first' })
  listAgentRuns(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('agentKey') agentKey?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ListAgentRunsResponse> {
    return this.runs.list(workspaceId, { agentKey, status, cursor });
  }

  @Get('agents/runs/:id')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'One run, with its findings' })
  getAgentRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<AgentRunSummary> {
    return this.runs.get(workspaceId, id);
  }

  @Post('agents/:key/run')
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Start a background run. It executes as the caller and is capped by the caller\'s role.',
  })
  startAgentRun(
    @Param('key') key: string,
    @Body() dto: StartAgentRunDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AgentRunSummary> {
    return this.runs.start(dto.workspaceId, key, principal, dto.note);
  }

  @Post('agents/route')
  @Access('viewer', 'body')
  @ApiOperation({
    summary: 'Ask the router which agent and model would handle a request, without running it',
  })
  async routeAgent(
    @Body() dto: RouteAgentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AgentRouteDecision> {
    return this.router.route(
      {
        workspaceId: dto.workspaceId,
        request: dto.request,
        surface: dto.surface,
        agentKey: dto.agentKey,
        locale: principal?.locale,
        userId: principal?.userId,
      },
      this.tiebreak,
    );
  }

  @Post('agents')
  @Access('admin', 'body')
  @ApiOperation({ summary: "Create an agent of the workspace's own, alongside the built-in roster" })
  async createAgent(
    @Body() dto: CreateAiAgentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiAgentSummary> {
    const agent = await this.agents.create(dto.workspaceId, dto, principal?.userId);
    await this.activity.record({
      workspaceId: dto.workspaceId,
      actor: principal?.userId,
      action: 'ai.agent.created',
      subjectId: agent.id ?? undefined,
      metadata: { key: agent.key, name: agent.name },
    });
    return agent;
  }

  @Patch('agents/:key')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Override an agent. Sending null for a field restores its shipped default.' })
  async updateAgent(
    @Param('key') key: string,
    @Body() dto: UpdateAiAgentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiAgentSummary> {
    const agent = await this.agents.update(dto.workspaceId, key, dto, principal?.userId);
    await this.activity.record({
      workspaceId: dto.workspaceId,
      actor: principal?.userId,
      action: 'ai.agent.updated',
      subjectId: agent.id ?? undefined,
      metadata: { key: agent.key },
    });
    return agent;
  }

  @Delete('agents/:key/override')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Reset a built-in agent: drop the override row so every field inherits again' })
  async resetAgent(
    @Param('key') key: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiAgentSummary> {
    const agent = await this.agents.reset(workspaceId, key);
    await this.activity.record({
      workspaceId,
      actor: principal?.userId,
      action: 'ai.agent.reset',
      metadata: { key },
    });
    return agent;
  }

  @Delete('agents/:key')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: "Delete one of the workspace's own agents. Built-ins are reset or disabled, never deleted." })
  async deleteAgent(
    @Param('key') key: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.agents.remove(workspaceId, key);
    await this.activity.record({
      workspaceId,
      actor: principal?.userId,
      action: 'ai.agent.deleted',
      metadata: { key },
    });
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
