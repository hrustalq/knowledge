import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AgentRun, AiAgent } from '@prisma/client';
import {
  ASSISTANT_TOOL_NAMES,
  BUILT_IN_AGENT_KEYS,
  type AgentFinding,
  type AgentRunStatus,
  type AgentRunSummary,
  type AgentRunTrigger,
  type AiAgentChoice,
  type AiAgentSummary,
  type ListAgentRunsResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { AiPluginsService } from './ai-plugins.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { AgentProducer } from '../agents/agent.producer.js';
import { RUNNABLE_AGENTS } from '../agents/agent.executor.js';
import type { Principal } from '../auth/principal.js';
import type { CreateAiAgentDto, UpdateAiAgentDto } from './ai.dto.js';

/** Columns an admin can override. Order drives the "overridden" badges in the UI. */
const OVERRIDABLE = [
  'name',
  'description',
  'instructions',
  'tools',
  'skillIds',
  'providerId',
  'temperature',
  'maxToolCalls',
  'timeoutMs',
] as const;

/**
 * The admin write surface for agents (docs/features/20).
 *
 * Deliberately separate from AgentRegistryService: resolving an agent happens
 * on background paths that run in the worker, while editing one is an
 * authenticated request that needs the plugin roster to validate a tool list.
 * That is the same Core/API split AiCoreModule has under AiModule, and it is
 * what keeps AgentCoreModule free of anything the worker cannot load.
 */
@Injectable()
export class AiAgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly plugins: AiPluginsService,
  ) {}

  async list(workspaceId: string): Promise<AiAgentSummary[]> {
    const [resolved, rows] = await Promise.all([
      this.registry.list(workspaceId),
      this.prisma.aiAgent.findMany({ where: { workspaceId } }),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return resolved.map((agent) => toSummary(agent, byKey.get(agent.key) ?? null));
  }

  /** Viewer-safe: names only. No prompts, no tool lists, no provider endpoints. */
  async choices(workspaceId: string): Promise<AiAgentChoice[]> {
    const resolved = await this.registry.list(workspaceId);
    return resolved
      .filter(
        (agent) =>
          agent.enabled &&
          agent.surfaces.includes('interactive') &&
          // The router picks an agent; offering it as one to pick is a category
          // error, and choosing it would just make the choice twice.
          agent.key !== 'router',
      )
      .map((agent) => ({ key: agent.key, name: agent.name, description: agent.description }));
  }

  /**
   * Upsert the sparse override row. A built-in has no row until this is first
   * called, which is what keeps an untouched workspace inheriting every future
   * improvement to a shipped prompt.
   */
  async update(workspaceId: string, key: string, dto: UpdateAiAgentDto, userId?: string): Promise<AiAgentSummary> {
    const isBuiltIn = (BUILT_IN_AGENT_KEYS as readonly string[]).includes(key);
    const existing = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    if (!isBuiltIn && !existing) throw new NotFoundException(`Unknown agent "${key}"`);

    await this.validate(workspaceId, dto.tools ?? undefined, dto.skillIds ?? undefined, dto.providerId ?? undefined);

    const data = {
      ...(dto.name === undefined ? {} : { name: dto.name }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.instructions === undefined ? {} : { instructions: dto.instructions }),
      ...(dto.tools === undefined ? {} : { tools: dto.tools ?? undefined }),
      ...(dto.skillIds === undefined ? {} : { skillIds: dto.skillIds ?? undefined }),
      ...(dto.providerId === undefined ? {} : { providerId: dto.providerId }),
      ...(dto.temperature === undefined ? {} : { temperature: dto.temperature }),
      ...(dto.maxToolCalls === undefined ? {} : { maxToolCalls: dto.maxToolCalls }),
      ...(dto.timeoutMs === undefined ? {} : { timeoutMs: dto.timeoutMs }),
      ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
      ...(dto.scheduleMinutes === undefined ? {} : { scheduleMinutes: dto.scheduleMinutes }),
      ...(dto.scheduleNote === undefined ? {} : { scheduleNote: dto.scheduleNote }),
      ...(dto.scheduleEnabled === undefined
        ? {}
        : {
            scheduleEnabled: dto.scheduleEnabled,
            // Turning a schedule on names its owner: unattended runs execute as
            // this person and are capped by their role. There is no ambient
            // identity to fall back on, so enabling without one is refused
            // rather than quietly running as nobody.
            ...(dto.scheduleEnabled ? { scheduleOwner: userId ?? existing?.scheduleOwner ?? null } : {}),
          }),
    };

    if (data.scheduleEnabled && !data.scheduleOwner && !existing?.scheduleOwner) {
      throw new BadRequestException('A scheduled agent needs an owner to run as.');
    }
    if (data.scheduleEnabled && !(dto.scheduleMinutes ?? existing?.scheduleMinutes)) {
      throw new BadRequestException('A scheduled agent needs an interval in minutes.');
    }

    await this.prisma.aiAgent.upsert({
      where: { workspaceId_key: { workspaceId, key } },
      create: { workspaceId, key, builtIn: isBuiltIn, createdBy: userId ?? null, ...data },
      update: data,
    });
    this.registry.invalidate(workspaceId);
    return this.one(workspaceId, key);
  }

  /**
   * Drop the override row entirely, so every field falls back to the code
   * default. For a custom agent there is no default to fall back to, so this
   * would delete it outright — use remove() for that, deliberately.
   */
  async reset(workspaceId: string, key: string): Promise<AiAgentSummary> {
    if (!(BUILT_IN_AGENT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`"${key}" is not a built-in agent — there is no default to reset to.`);
    }
    await this.prisma.aiAgent.deleteMany({ where: { workspaceId, key } });
    this.registry.invalidate(workspaceId);
    return this.one(workspaceId, key);
  }

  async create(workspaceId: string, dto: CreateAiAgentDto, userId?: string): Promise<AiAgentSummary> {
    const key = dto.key.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(key)) {
      throw new BadRequestException('Key must be lowercase letters, digits and dashes.');
    }
    // A custom agent shadowing a built-in would make `resolve` ambiguous and
    // silently take over a call site, so the namespace is closed at the front.
    if ((BUILT_IN_AGENT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`"${key}" is a built-in agent — edit it instead of creating one.`);
    }
    const clash = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    if (clash) throw new BadRequestException(`An agent named "${key}" already exists.`);

    await this.validate(workspaceId, dto.tools, dto.skillIds, dto.providerId ?? undefined);
    await this.prisma.aiAgent.create({
      data: {
        workspaceId,
        key,
        builtIn: false,
        name: dto.name,
        description: dto.description,
        instructions: dto.instructions,
        tools: dto.tools ?? [],
        skillIds: dto.skillIds ?? [],
        providerId: dto.providerId ?? null,
        createdBy: userId ?? null,
      },
    });
    this.registry.invalidate(workspaceId);
    return this.one(workspaceId, key);
  }

  async remove(workspaceId: string, key: string): Promise<void> {
    if ((BUILT_IN_AGENT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`"${key}" is a built-in agent — reset it or disable it instead of deleting.`);
    }
    const deleted = await this.prisma.aiAgent.deleteMany({ where: { workspaceId, key } });
    if (deleted.count === 0) throw new NotFoundException(`Unknown agent "${key}"`);
    this.registry.invalidate(workspaceId);
  }

  private async one(workspaceId: string, key: string): Promise<AiAgentSummary> {
    const [agent, row] = await Promise.all([
      this.registry.resolve(workspaceId, key),
      this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key } } }),
    ]);
    return toSummary(agent, row);
  }

  /**
   * Cross-tenant ids and unknown tool names are rejected on write rather than
   * at call time: a turn that quietly drops half its tools because a plugin was
   * renamed is far harder to diagnose than a 400 at the moment of saving.
   */
  private async validate(
    workspaceId: string,
    tools?: string[],
    skillIds?: string[],
    providerId?: string | null,
  ): Promise<void> {
    if (tools?.length) {
      const pluginTools = await this.plugins.toolsFor(workspaceId);
      const known = new Set<string>([
        ...ASSISTANT_TOOL_NAMES,
        ...pluginTools.map((tool) => tool.function.name),
      ]);
      const unknown = tools.filter((name) => !known.has(name));
      if (unknown.length) throw new BadRequestException(`Unknown tools: ${unknown.join(', ')}`);
    }
    if (skillIds?.length) {
      const found = await this.prisma.aiSkill.count({ where: { workspaceId, id: { in: skillIds } } });
      if (found !== new Set(skillIds).size) throw new BadRequestException('Unknown skill in skillIds.');
    }
    if (providerId) {
      const provider = await this.prisma.aiProvider.findUnique({ where: { id: providerId } });
      if (!provider || provider.workspaceId !== workspaceId) {
        throw new BadRequestException('Unknown provider profile.');
      }
    }
  }
}

function toSummary(agent: ResolvedAgent, row: AiAgent | null): AiAgentSummary {
  return {
    id: row?.id ?? null,
    key: agent.key,
    builtIn: agent.builtIn,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    tools: agent.tools,
    skillIds: agent.skillIds,
    providerId: agent.config.providerId,
    providerName: agent.config.providerName,
    temperature: agent.config.temperature,
    maxToolCalls: agent.config.maxToolCalls,
    timeoutMs: agent.config.timeoutMs,
    surfaces: agent.surfaces,
    requires: agent.requires,
    missing: agent.missing,
    purpose: agent.purpose,
    enabled: agent.enabled,
    overridden: row ? OVERRIDABLE.filter((field) => row[field] !== null) : [],
    scheduleEnabled: row?.scheduleEnabled ?? false,
    scheduleMinutes: row?.scheduleMinutes ?? null,
    scheduleNote: row?.scheduleNote ?? null,
    scheduleOwner: row?.scheduleOwner ?? null,
    lastRunAt: row?.lastRunAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Page size for the run list — the merge-request list's cursor convention. */
const RUNS_PAGE = 25;

/**
 * Starting and reading background runs (docs/features/20).
 *
 * `createdBy` comes from the authenticated caller and is never optional: a run
 * with nobody to bill or authorise as is the defect this feature exists not to
 * repeat (auto-triggered workflow runs bill a non-UUID and their spend is
 * silently dropped).
 */
@Injectable()
export class AgentRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly producer: AgentProducer,
  ) {}

  async start(workspaceId: string, agentKey: string, principal: Principal, note?: string): Promise<AgentRunSummary> {
    const agent = await this.registry.resolve(workspaceId, agentKey);
    if (!agent.enabled) throw new BadRequestException(`Agent "${agentKey}" is disabled.`);
    if (!agent.surfaces.includes('background') || !RUNNABLE_AGENTS.has(agentKey)) {
      throw new BadRequestException(`Agent "${agentKey}" cannot be run in the background.`);
    }
    // Checked at enqueue and again in the processor: a queued run can wait long
    // enough for the month's quota to be spent by something else.
    await this.usage.assertWithinBudget(workspaceId, principal.userId);

    // Back-pressure, the ConnectorScheduleSweeper rule: one run per agent at a
    // time, so an impatient second click queues nothing.
    const inFlight = await this.prisma.agentRun.count({
      where: { workspaceId, agentKey, status: { in: ['pending', 'running'] } },
    });
    if (inFlight > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `A run of "${agentKey}" is already in progress.`,
        reason: 'in-flight',
      });
    }

    const row = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key: agentKey } } });
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId,
        agentKey,
        agentId: row?.id ?? null,
        trigger: 'manual',
        createdBy: principal.userId,
        locale: principal.locale,
        input: note ? { note } : undefined,
      },
    });
    await this.producer.enqueue(run.id);
    return toRunSummary(run, agent.name);
  }

  async list(
    workspaceId: string,
    opts: { agentKey?: string; status?: string; cursor?: string },
  ): Promise<ListAgentRunsResponse> {
    const where = {
      workspaceId,
      ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const rows = await this.prisma.agentRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: RUNS_PAGE + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, RUNS_PAGE);

    // Counts come from a groupBy over the same scope minus the status filter,
    // so the tab badges reflect every status under the current search — the
    // merge-request list's `counts` reasoning.
    const { status: _ignored, ...baseWhere } = where as Record<string, unknown>;
    const grouped = await this.prisma.agentRun.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { _all: true },
    });
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 } as Record<
      AgentRunStatus,
      number
    >;
    for (const g of grouped) {
      if (g.status in counts) counts[g.status as AgentRunStatus] = g._count._all;
    }

    const names = new Map((await this.registry.list(workspaceId)).map((a) => [a.key, a.name]));
    return {
      runs: page.map((run) => toRunSummary(run, names.get(run.agentKey) ?? run.agentKey)),
      nextCursor: rows.length > RUNS_PAGE ? page[page.length - 1].id : null,
      counts,
    };
  }

  async get(workspaceId: string, id: string): Promise<AgentRunSummary> {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run || run.workspaceId !== workspaceId) throw new NotFoundException(`Unknown run ${id}`);
    const agent = await this.registry.resolve(workspaceId, run.agentKey).catch(() => null);
    return toRunSummary(run, agent?.name ?? run.agentKey);
  }
}

function toRunSummary(run: AgentRun, agentName: string): AgentRunSummary {
  const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    agentKey: run.agentKey,
    agentName,
    trigger: run.trigger as AgentRunTrigger,
    status: run.status as AgentRunStatus,
    createdBy: run.createdBy,
    summary: run.summary,
    findings,
    findingCount: findings.length,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}
