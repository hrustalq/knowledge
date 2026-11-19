import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AgentRun, type AiAgent } from '@prisma/client';
import {
  ASSISTANT_TOOL_NAMES,
  BUILT_IN_AGENT_KEYS,
  LEARNING_TARGETS,
  isConnectorScopedAgent,
  isPageScopedAgent,
  isValidTimezone,
  resolveAgentMemoryPolicy,
  type AgentFinding,
  type AgentRunInput,
  type AgentRunStatus,
  type AgentRunStep,
  type AgentRunStepKind,
  type AgentRunSummary,
  type AgentRunTrigger,
  type CostCurrency,
  type AiAgentChoice,
  type AiAgentSummary,
  type ListAgentRunStepsResponse,
  type ListAgentRunsResponse,
  type ModelTier,
  RUNNABLE_AGENTS,
} from '@knowledge/contracts';
import { mayReadRun, privateRunWhere, runFrameAddress } from './run-privacy.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { AiPluginsService } from './ai-plugins.service.js';
import { AiModelsService } from './ai-models.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { AgentProducer } from '../agents/agent.producer.js';
import { agentRunLockKey } from '../agents/agent.constants.js';
import { withSubjectLock } from '../common/subject-lock.js';
import { nextRunOf, scheduleKindOf, weekdaysOf } from '../agents/agent-schedule.js';
import type { Principal } from '../auth/principal.js';
import type { CreateAiAgentDto, UpdateAiAgentDto } from './ai.dto.js';

/** The fields whose change restarts a time-of-day schedule's slot count. */
const SCHEDULE_SHAPE = [
  'scheduleEnabled',
  'scheduleKind',
  'scheduleMinutes',
  'scheduleTime',
  'scheduleWeekdays',
  'scheduleTimezone',
] as const;

/** Columns an admin can override. Order drives the "overridden" badges in the UI. */
const OVERRIDABLE = [
  'name',
  'description',
  'instructions',
  'tools',
  'skillIds',
  'memoryPolicy',
  'modelId',
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
    private readonly models: AiModelsService,
  ) {}

  async list(workspaceId: string): Promise<AiAgentSummary[]> {
    const [resolved, rows] = await Promise.all([
      this.registry.list(workspaceId),
      this.prisma.aiAgent.findMany({ where: { workspaceId } }),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return resolved.map((agent) => toSummary(agent, byKey.get(agent.key) ?? null));
  }

  /**
   * Viewer-safe: names only. No prompts, no tool lists, no provider endpoints.
   *
   * `all` names every agent rather than the ones offered in the composer. A
   * thread, a learning or a run can carry any agent's key — a background agent
   * answering a mention (#70), a learning taught to the curator — and a key
   * nobody can name renders as itself.
   */
  async choices(workspaceId: string, scope: 'offered' | 'all' = 'offered'): Promise<AiAgentChoice[]> {
    return this.registry.choices(workspaceId, scope);
  }

  /**
   * Upsert the sparse override row. A built-in has no row until this is first
   * called, which is what keeps an untouched workspace inheriting every future
   * improvement to a shipped prompt.
   */
  async update(workspaceId: string, key: string, dto: UpdateAiAgentDto, userId?: string): Promise<AiAgentSummary> {
    const isBuiltIn = (BUILT_IN_AGENT_KEYS as readonly string[]).includes(key);
    const existing = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    if (!isBuiltIn && !existing) throw new NotFoundException(t('error.ai.agentNotFound', { key }));
    // A methodology's agent (#1127) is its methodology's text: here, only the
    // switch and the model pin, the overrides an admin keeps on top of it.
    if (existing?.blueprintId && Object.keys(dto).some((field) => !METHODOLOGY_AGENT_FIELDS.has(field))) {
      throw new BadRequestException(t('error.ai.agentFromMethodology', { key }));
    }

    await this.validate(workspaceId, dto.tools ?? undefined, dto.skillIds ?? undefined, dto.modelId ?? undefined);

    const data = {
      ...(dto.name === undefined ? {} : { name: dto.name }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.instructions === undefined ? {} : { instructions: dto.instructions }),
      ...(dto.tools === undefined ? {} : { tools: dto.tools ?? undefined }),
      ...(dto.skillIds === undefined ? {} : { skillIds: dto.skillIds ?? undefined }),
      ...(dto.memoryPolicy === undefined
        ? {}
        : { memoryPolicy: dto.memoryPolicy === null ? Prisma.DbNull : resolveAgentMemoryPolicy(dto.memoryPolicy) as unknown as Prisma.InputJsonValue }),
      ...(dto.modelId === undefined ? {} : { modelId: dto.modelId }),
      ...(dto.temperature === undefined ? {} : { temperature: dto.temperature }),
      ...(dto.maxToolCalls === undefined ? {} : { maxToolCalls: dto.maxToolCalls }),
      ...(dto.timeoutMs === undefined ? {} : { timeoutMs: dto.timeoutMs }),
      ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
      ...(dto.scheduleMinutes === undefined ? {} : { scheduleMinutes: dto.scheduleMinutes }),
      ...(dto.scheduleKind === undefined ? {} : { scheduleKind: dto.scheduleKind }),
      ...(dto.scheduleTime === undefined ? {} : { scheduleTime: dto.scheduleTime }),
      ...(dto.scheduleWeekdays === undefined
        ? {}
        : {
            scheduleWeekdays:
              dto.scheduleWeekdays === null
                ? Prisma.DbNull
                : [...new Set(dto.scheduleWeekdays)].sort((a, b) => a - b),
          }),
      ...(dto.scheduleTimezone === undefined ? {} : { scheduleTimezone: dto.scheduleTimezone }),
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
      throw new BadRequestException(t('error.ai.agentScheduleNeedsOwner'));
    }
    this.validateSchedule(dto, existing);

    // A changed shape restarts the slot count (#70): moving 09:00 to 08:00 at
    // ten o'clock must not fire "the missed 08:00" the moment it is saved.
    const reshaped = SCHEDULE_SHAPE.some((field) => dto[field] !== undefined);

    const written = { ...data, ...(reshaped ? { scheduleChangedAt: new Date() } : {}) };
    await this.prisma.aiAgent.upsert({
      where: { workspaceId_key: { workspaceId, key } },
      create: { workspaceId, key, builtIn: isBuiltIn, createdBy: userId ?? null, ...written },
      update: written,
    });
    this.registry.invalidate(workspaceId);
    return this.get(workspaceId, key);
  }

  /**
   * Drop the override row entirely, so every field falls back to the code
   * default. For a custom agent there is no default to fall back to, so this
   * would delete it outright — use remove() for that, deliberately.
   */
  async reset(workspaceId: string, key: string): Promise<AiAgentSummary> {
    if (!(BUILT_IN_AGENT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(t('error.ai.agentNotBuiltIn', { key }));
    }
    await this.prisma.aiAgent.deleteMany({ where: { workspaceId, key } });
    this.registry.invalidate(workspaceId);
    return this.get(workspaceId, key);
  }

  /** `minTier` is not on the route's DTO: only a copy of a methodology's agent carries one (#1314). */
  async create(workspaceId: string, dto: CreateAiAgentDto & { minTier?: ModelTier | null }, userId?: string): Promise<AiAgentSummary> {
    const key = dto.key.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(key)) {
      throw new BadRequestException(t('error.ai.agentKeyInvalid'));
    }
    // A custom agent shadowing a built-in would make `resolve` ambiguous and
    // silently take over a call site, so the namespace is closed at the front.
    // `mcp` is the learning target for external agents (#305): a custom agent
    // under it would be handed their learnings.
    if ((LEARNING_TARGETS as readonly string[]).includes(key)) {
      throw new BadRequestException(t('error.ai.agentIsBuiltInCreate', { key }));
    }
    const clash = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    if (clash) throw new BadRequestException(t('error.ai.agentNameTaken', { key }));

    await this.validate(workspaceId, dto.tools, dto.skillIds, dto.modelId ?? undefined);
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
        memoryPolicy: dto.memoryPolicy ? resolveAgentMemoryPolicy(dto.memoryPolicy) as unknown as Prisma.InputJsonValue : undefined,
        modelId: dto.modelId ?? null,
        minTier: dto.minTier ?? null,
        createdBy: userId ?? null,
      },
    });
    this.registry.invalidate(workspaceId);
    return this.get(workspaceId, key);
  }

  async remove(workspaceId: string, key: string): Promise<void> {
    if ((BUILT_IN_AGENT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(t('error.ai.agentIsBuiltInDelete', { key }));
    }
    // A methodology's agent goes when the methodology stops declaring it (switched off), never here.
    if (await this.prisma.aiAgent.count({ where: { workspaceId, key, blueprintId: { not: null } } })) {
      throw new BadRequestException(t('error.ai.agentFromMethodology', { key }));
    }
    const deleted = await this.prisma.aiAgent.deleteMany({ where: { workspaceId, key } });
    if (deleted.count === 0) throw new NotFoundException(t('error.ai.agentNotFound', { key }));
    this.registry.invalidate(workspaceId);
  }

  async get(workspaceId: string, key: string): Promise<AiAgentSummary> {
    const [agent, row] = await Promise.all([
      this.registry.resolve(workspaceId, key),
      this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key } } }),
    ]);
    return toSummary(agent, row);
  }

  /**
   * An enabled schedule must be able to fire, judged on the row as it will be
   * after this write: the field from the request where it names one (null
   * included), the stored one otherwise. Checked whenever the result is
   * enabled, not only on the request that enables it — switching an enabled
   * schedule to weekly without weekdays would otherwise save a schedule that
   * silently never runs.
   */
  private validateSchedule(dto: UpdateAiAgentDto, existing: AiAgent | null): void {
    if (dto.scheduleTimezone && !isValidTimezone(dto.scheduleTimezone)) {
      throw new BadRequestException(t('error.ai.agentScheduleBadTimezone', { zone: dto.scheduleTimezone }));
    }
    const enabled = dto.scheduleEnabled ?? existing?.scheduleEnabled ?? false;
    if (!enabled) return;
    const pick = <K extends (typeof SCHEDULE_SHAPE)[number]>(field: K) =>
      dto[field] !== undefined ? dto[field] : existing?.[field];
    const kind = scheduleKindOf(pick('scheduleKind') ?? null);
    if (kind === 'interval') {
      if (!pick('scheduleMinutes')) throw new BadRequestException(t('error.ai.agentScheduleNeedsInterval'));
      return;
    }
    if (!pick('scheduleTime')) throw new BadRequestException(t('error.ai.agentScheduleNeedsTime'));
    if (kind === 'weekly' && !weekdaysOf(pick('scheduleWeekdays'))?.length) {
      throw new BadRequestException(t('error.ai.agentScheduleNeedsWeekdays'));
    }
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
    modelId?: string | null,
  ): Promise<void> {
    if (tools?.length) {
      const pluginTools = await this.plugins.toolsFor(workspaceId);
      const known = new Set<string>([
        ...ASSISTANT_TOOL_NAMES,
        ...pluginTools.map((tool) => tool.function.name),
      ]);
      const unknown = tools.filter((name) => !known.has(name));
      if (unknown.length) throw new BadRequestException(t('error.ai.agentUnknownTools', { tools: unknown.join(', ') }));
    }
    if (skillIds?.length) {
      const found = await this.prisma.aiSkill.count({ where: { workspaceId, kind: 'skill', id: { in: skillIds } } });
      if (found !== new Set(skillIds).size) throw new BadRequestException(t('error.ai.agentUnknownSkill'));
    }
    if (modelId) await this.models.assertInWorkspace(workspaceId, [modelId]);
  }
}

/** What an admin may change on a methodology's agent: its switch and its model pin. */
const METHODOLOGY_AGENT_FIELDS = new Set(['enabled', 'modelId']);

function toSummary(agent: ResolvedAgent, row: AiAgent | null): AiAgentSummary {
  return {
    id: row?.id ?? null,
    key: agent.key,
    builtIn: agent.builtIn,
    blueprintId: agent.blueprintId,
    minTier: agent.minTier,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    tools: agent.tools,
    skillIds: agent.skillIds,
    memoryPolicy: agent.memoryPolicy,
    modelId: row?.modelId ?? null,
    model: agent.config.model,
    providerName: agent.config.providerName,
    temperature: agent.config.temperature,
    maxToolCalls: agent.config.maxToolCalls,
    timeoutMs: agent.config.timeoutMs,
    surfaces: agent.surfaces,
    runnable: RUNNABLE_AGENTS.has(agent.key),
    requires: agent.requires,
    missing: agent.missing,
    purpose: agent.purpose,
    enabled: agent.enabled,
    overridden: row ? OVERRIDABLE.filter((field) => row[field] !== null) : [],
    scheduleEnabled: row?.scheduleEnabled ?? false,
    scheduleKind: scheduleKindOf(row?.scheduleKind ?? null),
    scheduleMinutes: row?.scheduleMinutes ?? null,
    scheduleTime: row?.scheduleTime ?? null,
    scheduleWeekdays: weekdaysOf(row?.scheduleWeekdays),
    scheduleTimezone: row?.scheduleTimezone ?? null,
    scheduleNote: row?.scheduleNote ?? null,
    scheduleOwner: row?.scheduleOwner ?? null,
    lastRunAt: row?.lastRunAt?.toISOString() ?? null,
    // Only a schedule that can actually start has a next run: an owner is
    // what the sweeper requires, and the agent must have an executor.
    nextRunAt:
      row?.scheduleOwner && agent.enabled && RUNNABLE_AGENTS.has(agent.key)
        ? (nextRunOf(row)?.toISOString() ?? null)
        : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Page size for the run list — the merge-request list's cursor convention. */
const RUNS_PAGE = 25;
/** Steps per page of a run's log (#1247). */
const STEPS_PAGE = 200;

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
    private readonly events: EventsPublisher,
  ) {}

  async start(
    workspaceId: string,
    agentKey: string,
    principal: Principal,
    // `projectId` only narrows which repository is chosen; the run stores the connector.
    input: AgentRunInput & { projectId?: string } = {},
  ): Promise<AgentRunSummary> {
    const agent = await this.registry.resolve(workspaceId, agentKey);
    if (!agent.enabled) throw new BadRequestException(t('error.ai.agentDisabled', { key: agentKey }));
    if (!RUNNABLE_AGENTS.has(agentKey)) {
      throw new BadRequestException(t('error.ai.agentNotBackground', { key: agentKey }));
    }
    // A connector-scoped agent (docs/features/31) reads one repository. The
    // scope is settled here, where the person who pressed Run can be told what
    // is wrong, rather than in the worker where the run would simply fail:
    // a named connector must be an enabled repository in this workspace, and
    // an unnamed one is fine only when there is exactly one to choose — in
    // the named project, when there is one (#553).
    const connectorId = await this.resolveScope(workspaceId, agentKey, input.connectorId, input.projectId);
    // Pages only mean something to an executor that reads pages; anything else
    // would ignore them and run workspace-wide, which is not what was asked.
    const documentIds = input.documentIds?.length ? [...new Set(input.documentIds)] : null;
    if (documentIds && !isPageScopedAgent(agentKey)) {
      throw new BadRequestException(t('error.ai.agentNotPageScoped', { key: agentKey }));
    }
    // Checked at enqueue and again in the processor: a queued run can wait long
    // enough for the month's quota to be spent by something else.
    await this.usage.assertWithinBudget(workspaceId, principal.userId);

    // A run about one page carries that page as its subject (#1248), the key
    // the trigger guard already reads, so the processor runs it after any other
    // agent's run on the same page instead of beside it.
    // ponytail: a multi-page run stays unscoped (per-agent lock only); give it one subject row per page if overlapping page sets collide in practice.
    const subjectKey = documentIds?.length === 1 ? `doc:${documentIds[0]}` : null;

    // Back-pressure, the ConnectorScheduleSweeper rule: one run per agent at a
    // time, so an impatient second click queues nothing. Count and insert under
    // one lock (#815), or two clicks both count zero. A page run counts only
    // this agent's runs on that page, and an unscoped run only unscoped ones:
    // a workspace-wide pass never blocks a page run, nor the reverse (#1248).
    const run = await withSubjectLock(this.prisma, agentRunLockKey(workspaceId, agentKey), async () => {
      const inFlight = await this.prisma.agentRun.count({
        where: { workspaceId, agentKey, subjectKey, status: { in: ['pending', 'running'] } },
      });
      if (inFlight > 0) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.ai.agentRunInFlight', { key: agentKey }),
          reason: 'in-flight',
        });
      }

      const row = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key: agentKey } } });
      return this.prisma.agentRun.create({
        data: {
          workspaceId,
          agentKey,
          agentId: row?.id ?? null,
          trigger: 'manual',
          subjectKey,
          createdBy: principal.userId,
          locale: principal.locale,
          input:
            input.note || connectorId || documentIds
              ? {
                  ...(input.note ? { note: input.note } : {}),
                  ...(connectorId ? { connectorId } : {}),
                  ...(documentIds ? { documentIds } : {}),
                }
              : undefined,
        },
      });
    });
    await this.producer.enqueue(run.id);
    const behind = await this.blockers(workspaceId, [run], principal);
    return toRunSummary(run, agent.name, behind);
  }

  /**
   * The repository a connector-scoped run reads, or null for an agent that
   * takes no scope. Read through prisma rather than ConnectorsService — this
   * module has no edge to the connectors layer and needs only four columns.
   *
   * A restricted project's repository is never eligible: the run reads as its
   * owner clamped to the workspace (its findings are read by everyone), so
   * the worker would refuse it as not found (#553). Leaving it out here also
   * keeps its name out of the error that lists a project's candidates.
   */
  private async resolveScope(
    workspaceId: string,
    agentKey: string,
    requested?: string,
    projectId?: string,
  ): Promise<string | null> {
    if (!isConnectorScopedAgent(agentKey)) return null;
    const eligible = {
      workspaceId,
      enabled: true,
      kind: { in: ['codebase', 'markdown-git'] },
      project: { restricted: false },
      ...(projectId ? { projectId } : {}),
    };
    if (requested) {
      const row = await this.prisma.connector.findFirst({ where: { id: requested, ...eligible }, select: { id: true } });
      if (!row) throw new BadRequestException(t('error.ai.agentConnectorInvalid', { id: requested }));
      return row.id;
    }
    const rows = await this.prisma.connector.findMany({
      where: eligible,
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
      take: projectId ? 10 : 2,
    });
    if (rows.length === 1) return rows[0].id;
    if (!projectId) throw new BadRequestException(t('error.ai.agentNeedsConnector', { key: agentKey }));
    throw new BadRequestException(
      rows.length === 0
        ? t('error.ai.agentProjectNoRepository', { key: agentKey })
        : t('error.ai.agentProjectManyRepositories', { key: agentKey, names: rows.map((r) => r.name).join(', ') }),
    );
  }

  /** `principal`: a memo's analysis is listed for its uploader only (#1089, `privateRunWhere`). */
  async list(
    workspaceId: string,
    opts: { agentKey?: string; status?: string; cursor?: string },
    principal: Principal,
  ): Promise<ListAgentRunsResponse> {
    const where = {
      workspaceId,
      ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...privateRunWhere(principal),
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
    const behind = await this.blockers(workspaceId, page, principal, names);
    return {
      runs: page.map((run) => toRunSummary(run, names.get(run.agentKey) ?? run.agentKey, behind)),
      nextCursor: rows.length > RUNS_PAGE ? page[page.length - 1].id : null,
      counts,
    };
  }

  async get(workspaceId: string, id: string, principal: Principal): Promise<AgentRunSummary> {
    const run = await this.readable(workspaceId, id, principal);
    const agent = await this.registry.resolve(workspaceId, run.agentKey).catch(() => null);
    return toRunSummary(run, agent?.name ?? run.agentKey, await this.blockers(workspaceId, [run], principal));
  }

  /**
   * A run's step log (#1247), oldest first from `cursor` (the last step id
   * read), with what its model calls cost so far. Read under the run's own
   * rule: a private run's steps are as missing as the run.
   */
  async steps(workspaceId: string, id: string, principal: Principal, cursor?: string): Promise<ListAgentRunStepsResponse> {
    await this.readable(workspaceId, id, principal);
    const after = cursor && /^\d{1,18}$/.test(cursor) ? BigInt(cursor) : null;
    const [rows, billed] = await Promise.all([
      this.prisma.agentRunStep.findMany({
        where: { runId: id, ...(after === null ? {} : { id: { gt: after } }) },
        orderBy: { id: 'asc' },
        take: STEPS_PAGE + 1,
      }),
      this.prisma.aiUsage.groupBy({
        by: ['costCurrency', 'estimated'],
        where: { workspaceId, agentRunId: id },
        _count: { _all: true },
        _sum: { totalTokens: true, costMicros: true },
      }),
    ]);
    const page = rows.slice(0, STEPS_PAGE);
    const costs = new Map<CostCurrency, number>();
    for (const g of billed) {
      const currency = g.costCurrency as CostCurrency;
      if (g._sum.costMicros !== null) costs.set(currency, (costs.get(currency) ?? 0) + g._sum.costMicros);
    }
    return {
      steps: page.map(toStep),
      nextCursor: rows.length > STEPS_PAGE ? page[page.length - 1].id.toString() : null,
      usage: {
        calls: billed.reduce((n, g) => n + g._count._all, 0),
        totalTokens: billed.reduce((n, g) => n + (g._sum.totalTokens ?? 0), 0),
        estimated: billed.some((g) => g.estimated),
        costs: [...costs].map(([currency, micros]) => ({ currency, micros })),
      },
    };
  }

  /**
   * Cancel a pending or running run (#1247): one guarded write to `cancelled`.
   * A pending run never starts — the claim takes only `pending` — and a
   * running one stops before its next step, when the worker's next guarded
   * write lands nothing. 409 for a run that has already settled.
   */
  async cancel(workspaceId: string, id: string, principal: Principal): Promise<AgentRunSummary> {
    const run = await this.readable(workspaceId, id, principal);
    const cancelled = await this.prisma.agentRun.updateMany({
      where: { id, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', stage: null, finishedAt: new Date() },
    });
    if (cancelled.count === 0) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.ai.agentRunNotCancellable', { id }),
        reason: 'settled',
      });
    }
    await this.events.publish({ type: 'agent.run.cancelled', workspaceId, subjectId: id, ...runFrameAddress(run) });
    return this.get(workspaceId, id, principal);
  }

  /** The run, when this person may read it; a run of another workspace or a private one is a 404. */
  private async readable(workspaceId: string, id: string, principal: Principal): Promise<AgentRun> {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run || run.workspaceId !== workspaceId || !mayReadRun(run, principal)) {
      throw new NotFoundException(t('error.ai.agentRunNotFound', { id }));
    }
    return run;
  }

  /**
   * Why a pending run is waiting (#1248): the run `running` on its subject,
   * keyed by subject. Derived on read, never stored — the processor's claim
   * reads the same rows. A blocker the reader may not see (a memo's analysis,
   * a restricted project's check) is left out, so the run reads as plainly queued.
   */
  private async blockers(
    workspaceId: string,
    runs: AgentRun[],
    principal: Principal,
    names?: Map<string, string>,
  ): Promise<Map<string, AgentRunSummary['queuedBehind']>> {
    const subjects = [...new Set(runs.flatMap((r) => (r.status === 'pending' && r.subjectKey ? [r.subjectKey] : [])))];
    if (subjects.length === 0) return new Map();
    const running = await this.prisma.agentRun.findMany({
      where: { workspaceId, status: 'running', subjectKey: { in: subjects }, ...privateRunWhere(principal) },
      select: { id: true, agentKey: true, subjectKey: true },
    });
    const named = names ?? new Map((await this.registry.list(workspaceId)).map((a) => [a.key, a.name]));
    return new Map(running.map((r) => [r.subjectKey!, { runId: r.id, agentName: named.get(r.agentKey) ?? r.agentKey }]));
  }
}

function toStep(row: {
  id: bigint;
  kind: string;
  name: string | null;
  args: string | null;
  output: string | null;
  sources: Prisma.JsonValue;
  ok: boolean;
  tokens: number | null;
  durationMs: number | null;
  createdAt: Date;
}): AgentRunStep {
  return {
    id: row.id.toString(),
    kind: row.kind as AgentRunStepKind,
    name: row.name,
    args: row.args,
    output: row.output,
    sources: Array.isArray(row.sources) ? (row.sources as AgentRunStep['sources']) : [],
    ok: row.ok,
    tokens: row.tokens,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRunSummary(
  run: AgentRun,
  agentName: string,
  behind: Map<string, AgentRunSummary['queuedBehind']> = new Map(),
): AgentRunSummary {
  const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    agentKey: run.agentKey,
    agentName,
    trigger: run.trigger as AgentRunTrigger,
    triggerId: run.triggerId,
    subjectKey: run.subjectKey,
    status: run.status as AgentRunStatus,
    createdBy: run.createdBy,
    input: run.input && typeof run.input === 'object' ? (run.input as AgentRunInput) : null,
    summary: run.summary,
    findings,
    findingCount: findings.length,
    queuedBehind: (run.status === 'pending' && run.subjectKey && behind.get(run.subjectKey)) || null,
    error: run.error,
    // Progress as the run wrote it (docs/features/29). `stage` is free text from
    // the executor rather than a closed enum, so the web renders it through
    // `labelFor` and falls back to the raw value — the documents.category rule.
    stage: run.stage,
    progress: run.progress,
    warnings: Array.isArray(run.warnings)
      ? (run.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
      : [],
    model: run.model,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}
