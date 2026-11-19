import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigurationProposal as ProposalRow, Prisma } from '@prisma/client';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import {
  AGENT_TRIGGER_EVENTS,
  CONFIGURATION_CHANGE_KINDS,
  AUTHORABLE_RELATION_TYPES,
  BUILT_IN_TEMPLATE_KEYS,
  CONNECTOR_KIND_INFO,
  DOCUMENT_CATEGORIES,
  DRIFT_CHECK_CONFIG_KEY,
  DRIFT_CHECK_MODES,
  RUNNABLE_AGENTS,
  SYSTEM_PLACEHOLDERS,
  TEMPLATE_PLACEHOLDER_KINDS,
  WORKFLOW_STEP_KINDS,
  agentTriggerEventsFor,
  builtInTemplateRef,
  driftCheckMode,
  isTriggerableAgent,
  type AgentTriggerFilter,
  type ConfigurationChange,
  type ConfigurationChangeSpec,
  type ConfigurationDiffRow,
  type ConfigurationProposal,
  type ConfigurationUnavailableReason,
  type ProposeConfigurationResponse,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import { FeaturesService } from '../auth/features.service.js';
import type { Principal } from '../auth/principal.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { filterOf } from '../agents/agent-trigger.service.js';
import { scheduleKindOf, weekdaysOf } from '../agents/agent-schedule.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { mergeFilter } from '../ai/agent-triggers.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ConnectorsService } from '../connectors/connectors.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { templateIssues } from '../workflows/workflow-templates.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { t } from '../i18n/t.js';
import { WORKFLOW_EVENTS, readChanges, type ReadChange } from './configuration-changes.js';

/** Proposals listed at once, newest first. Older ones are history nobody reviews. */
const LIST_LIMIT = 20;

/** Repository connectors that have a drift check: the ones whose form offers the field. */
const DRIFT_KINDS: ReadonlySet<string> = new Set(
  CONNECTOR_KIND_INFO.filter((info) => info.fields.some((f) => f.key === DRIFT_CHECK_CONFIG_KEY)).map((info) => info.kind),
);

const PROPOSE_TOOL = 'propose_configuration';

/**
 * The configurator's tools — this service's contract, not the agent's
 * editable list (see its entry in `built-in-agents.ts`). Four reads and the one
 * write, which writes a proposal and nothing else.
 */
const TOOLS: ChatCompletionFunctionTool[] = [
  tool('list_agents', 'The agents that can run on a schedule or be triggered, with each one\'s current schedule and the trigger events it accepts.'),
  tool('list_agent_triggers', 'Every agent trigger in the workspace: agent, event, project, filter and whether it is on.'),
  tool('list_projects', 'Projects you may see, with their ids.'),
  tool('list_connectors', 'Repository connectors that have a drift check, with their current mode.'),
  tool('list_workflows', 'Workspace-wide workflow definitions: name, description and whether each is on.'),
  tool('list_templates', 'Workspace-wide page templates and built-ins: ref, name and the category of page each writes.'),
  {
    type: 'function',
    function: {
      name: PROPOSE_TOOL,
      description:
        'Write the proposal: every change the goal needs. Calling it again replaces the previous call. Returns which ' +
        'changes were accepted and why any were not.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['changes'],
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'reason'],
              properties: {
                kind: { type: 'string', enum: [...CONFIGURATION_CHANGE_KINDS] },
                reason: { type: 'string', description: 'One line: why the goal needs this change.' },
                agentKey: { type: 'string', description: 'agent-schedule, agent-trigger' },
                scheduleKind: { type: 'string', enum: ['interval', 'daily', 'weekly'], description: 'agent-schedule' },
                scheduleMinutes: { type: 'integer', description: 'agent-schedule, interval: minutes between runs (15–20160)' },
                scheduleTime: { type: 'string', description: 'agent-schedule, daily/weekly: HH:MM, 24-hour' },
                scheduleWeekdays: { type: 'array', items: { type: 'integer' }, description: 'agent-schedule, weekly: 0 = Sunday … 6 = Saturday' },
                scheduleTimezone: { type: 'string', description: 'agent-schedule: IANA zone; omit to use the person\'s' },
                event: { type: 'string', enum: [...AGENT_TRIGGER_EVENTS], description: 'agent-trigger' },
                projectId: { type: 'string', description: 'agent-trigger, workflow-draft, page-template: only this project; omit for every project (a workspace-wide template needs an admin to apply)' },
                categories: { type: 'array', items: { type: 'string' }, description: `agent-trigger, workflow-draft: only pages of these categories (workflow-draft: ${DOCUMENT_CATEGORIES.join(', ')})` },
                connectorIds: { type: 'array', items: { type: 'string' }, description: 'agent-trigger: only these connectors' },
                branch: { type: 'string', description: 'agent-trigger: only this branch' },
                labels: { type: 'array', items: { type: 'string' }, description: 'agent-trigger, work-item.updated: only tickets with these labels' },
                note: { type: 'string', description: 'agent-schedule, agent-trigger: an extra instruction for every run it starts' },
                connectorId: { type: 'string', description: 'connector-drift-check' },
                mode: { type: 'string', enum: [...DRIFT_CHECK_MODES], description: 'connector-drift-check' },
                name: { type: 'string', description: 'workflow-draft, page-template: a short name, unique in the workspace' },
                description: { type: 'string', description: 'workflow-draft, page-template: one line on what it is for' },
                steps: {
                  type: 'array',
                  description:
                    'workflow-draft: the chain. Exactly one step has nothing pointing at it, which is where a run starts on a page. ' +
                    '"ai.generate" fans out a list, "ai.draft" writes one page per item, "review" waits for a person.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'lower-case-dashed slug' },
                      kind: { type: 'string', enum: [...WORKFLOW_STEP_KINDS] },
                      title: { type: 'string' },
                      prompt: { type: 'string', description: 'ai.* only: what the model running this step is told' },
                      next: { type: 'array', items: { type: 'string' }, description: 'ids of the steps that run after this one' },
                      fanOut: { type: 'boolean', description: 'ai.generate only' },
                      maxItems: { type: 'integer', description: 'ai.generate: 1–50' },
                      produces: {
                        type: 'object',
                        description: 'a step that writes pages: their category, the edge to the page they came from, optionally a template',
                        properties: {
                          category: { type: 'string', enum: [...DOCUMENT_CATEGORIES] },
                          relationToParent: { type: 'string', enum: [...AUTHORABLE_RELATION_TYPES] },
                          templateRef: { type: 'string', description: `a ref from list_templates, or one of ${BUILT_IN_TEMPLATE_KEYS.map(builtInTemplateRef).join(', ')}` },
                        },
                      },
                    },
                  },
                },
                autoStart: { type: 'boolean', description: 'workflow-draft: start a run on its own when one of events fires on a matching page' },
                events: { type: 'array', items: { type: 'string', enum: WORKFLOW_EVENTS }, description: 'workflow-draft, with autoStart: revision.indexed is "a page was merged or published"' },
                source: {
                  type: 'string',
                  description:
                    'page-template: markdown with frontmatter. A reserved `template:` mapping carries `category` ' +
                    `(${DOCUMENT_CATEGORIES.join(', ')}), \`titlePattern\` and \`placeholders\`: a list of mappings ` +
                    `{ name, label, kind: ${TEMPLATE_PLACEHOLDER_KINDS.join(' | ')}, required }, never bare strings. ` +
                    `The body uses them as {{name}}; ${SYSTEM_PLACEHOLDERS.map((n) => `{{${n}}}`).join(', ')} need no declaration.`,
                },
              },
            },
          },
        },
      },
    },
  },
];

/**
 * The configurator (#1250): a goal in, a stored proposal out.
 *
 * The model reads today's configuration through the read tools and writes one
 * thing — the proposal row, through `propose_configuration`. Nothing it can
 * call writes a setting: the executor answers only the names in `TOOLS`, on
 * execution. Every change is narrowed by `readChanges` and then assessed here
 * against the workspace (`assess`), which is also what `ConfigurationApplyService`
 * asks again at apply time, so "already configured" and "the server has it
 * switched off" have one answer on both sides.
 */
@Injectable()
export class ConfiguratorService {
  private readonly schedulesOn: boolean;
  private readonly triggersOn: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentRegistryService,
    private readonly aiUsage: AiUsageService,
    private readonly client: AssistantClient,
    private readonly permissions: PermissionService,
    private readonly access: AccessService,
    private readonly projects: ProjectsService,
    private readonly connectors: ConnectorsService,
    private readonly features: FeaturesService,
    private readonly templates: TemplatesService,
    config: ConfigService<Env, true>,
  ) {
    this.schedulesOn = config.get('AGENT_SCHEDULE_ENABLED', { infer: true }) === true;
    this.triggersOn = config.get('AGENT_TRIGGERS_ENABLED', { infer: true }) === true;
  }

  async propose(
    workspaceId: string,
    goal: string,
    timezone: string | null,
    principal: Principal,
  ): Promise<ProposeConfigurationResponse> {
    const agent = await this.agents.resolve(workspaceId, 'configurator');
    if (!agent.enabled || !agent.config.enabled || agent.missing.length) {
      throw new BadRequestException(t('error.ai.agentDisabled', { key: agent.name }));
    }
    await this.aiUsage.assertWithinBudget(workspaceId, principal.userId);

    let proposalId: string | null = null;
    const { content } = await this.client.runWithTools(
      { config: agent.config, userId: principal.userId, operation: 'configurator', locale: principal.locale },
      [
        { role: 'system', content: agent.instructions },
        {
          role: 'user',
          // The zone is the person's browser's: a time they name is read in it unless the goal names another.
          content:
            `The goal:\n${wrapUntrusted(goal, 'configurator', 'brief')}` +
            (timezone ? `\n\nThe person's timezone is ${timezone}. Leave scheduleTimezone out unless the goal names another zone.` : ''),
        },
      ],
      TOOLS,
      async (name, args) => {
        // Answered on execution, whatever the model was offered.
        if (name === PROPOSE_TOOL) {
          const { changes, dropped } = readChanges(args.changes, timezone);
          const assessed = await this.assess(workspaceId, changes);
          // Nothing accepted writes nothing: an empty proposal is a history row with nothing to review.
          if (assessed.length) proposalId = (await this.write(proposalId, workspaceId, goal, assessed, principal.userId)).id;
          return {
            content: JSON.stringify({
              accepted: assessed.map((c) => ({ kind: c.spec.kind, target: c.target, unavailable: c.unavailable })),
              dropped,
            }),
          };
        }
        const read = await this.read(name, workspaceId, principal);
        return read === null
          ? { content: JSON.stringify({ error: `Unknown tool ${name}` }), ok: false }
          : { content: wrapUntrusted(JSON.stringify(read), 'configurator', 'document') };
      },
    );

    const reply = content.trim().slice(0, 4_000);
    if (!proposalId) return { proposal: null, reply: reply || t('agent.configuratorNothingProposed') };
    const row = await this.prisma.configurationProposal.update({ where: { id: proposalId }, data: { summary: reply } });
    return { proposal: toProposal(row), reply };
  }

  async list(workspaceId: string, principal: Principal): Promise<ConfigurationProposal[]> {
    // An admin reviews everyone's; anyone else sees their own.
    const mine = (await this.isAdmin(principal, workspaceId)) ? {} : { createdBy: principal.userId };
    const rows = await this.prisma.configurationProposal.findMany({
      where: { workspaceId, ...mine },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map(toProposal);
  }

  /** One proposal the caller may see: their own, or any for an admin. 404 otherwise, as for a missing one. */
  async require(id: string, workspaceId: string, principal: Principal): Promise<ProposalRow> {
    const row = await this.prisma.configurationProposal.findFirst({ where: { id, workspaceId } });
    if (!row || (row.createdBy !== principal.userId && !(await this.isAdmin(principal, workspaceId)))) {
      throw new NotFoundException(t('error.configurator.notFound', { id }));
    }
    return row;
  }

  /** Set every pending change aside: the "none" of apply all, some or none. */
  async dismiss(id: string, workspaceId: string, principal: Principal): Promise<ConfigurationProposal> {
    const row = await this.require(id, workspaceId, principal);
    const changes = changesOf(row).map((c) => (c.state === 'pending' ? { ...c, state: 'dismissed' as const } : c));
    const updated = await this.prisma.configurationProposal.update({
      where: { id },
      data: { changes: changes as unknown as Prisma.InputJsonValue },
    });
    return toProposal(updated);
  }

  /**
   * Each change against the workspace as it is now: its target's name, the
   * diff against today, and whether it can be applied at all. Pure reads.
   */
  async assess(workspaceId: string, changes: ReadChange[]): Promise<ConfigurationChange[]> {
    const out: ConfigurationChange[] = [];
    const sectionOff = (await this.features.disabled(workspaceId)).includes('workflows');
    for (const [i, { spec, reason }] of changes.entries()) {
      const { target, diff, unavailable, normalized } = await this.assessOne(workspaceId, spec, sectionOff);
      out.push({
        id: `c${i + 1}`,
        spec: normalized,
        reason,
        target,
        diff,
        state: unavailable ? 'unavailable' : 'pending',
        unavailable,
        requires: requiresFor(normalized),
        appliedAt: null,
        appliedBy: null,
        resultId: null,
      });
    }
    return out;
  }

  private async assessOne(
    workspaceId: string,
    spec: ConfigurationChangeSpec,
    sectionOff: boolean,
  ): Promise<{ target: string; diff: ConfigurationDiffRow[]; unavailable: ConfigurationUnavailableReason | null; normalized: ConfigurationChangeSpec }> {
    switch (spec.kind) {
      case 'agent-schedule': {
        const name = await this.agentName(workspaceId, spec.agentKey);
        const row = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key: spec.agentKey } } });
        // No schedule shape stored at all reads as "nothing today", the recipes' `hasSchedule`.
        const has = !!row && (row.scheduleKind !== null || row.scheduleMinutes !== null || row.scheduleTime !== null);
        const before = {
          scheduleKind: has ? scheduleKindOf(row!.scheduleKind) : null,
          scheduleMinutes: has ? row!.scheduleMinutes : null,
          scheduleTime: has ? row!.scheduleTime : null,
          scheduleWeekdays: has ? weekdaysOf(row!.scheduleWeekdays) : null,
          scheduleTimezone: has ? row!.scheduleTimezone : null,
          // A change with no note keeps the one there; apply sends only a note it names.
          ...(spec.scheduleNote === null ? {} : { scheduleNote: row?.scheduleNote ?? null }),
        };
        const diff = diffRows(before, spec);
        const unavailable =
          name === null ? 'not-found'
          : !RUNNABLE_AGENTS.has(spec.agentKey) ? 'agent-unsupported'
          : !this.schedulesOn ? 'schedules-off'
          : diff.every((d) => same(d.before, d.after)) ? 'already-configured'
          : null;
        return { target: name ?? spec.agentKey, diff, unavailable, normalized: spec };
      }

      case 'agent-trigger': {
        const name = await this.agentName(workspaceId, spec.agentKey);
        // Only the filter fields the event has a dimension for — the rule the trigger writer applies.
        const filter = mergeFilter(spec.event, {}, spec.filter);
        const normalized = { ...spec, filter };
        const projectOk = await this.projectIn(workspaceId, spec.projectId);
        const ids = filter.connectorIds ?? [];
        const connectorsOk = !ids.length || (await this.prisma.connector.count({ where: { id: { in: ids }, workspaceId } })) === ids.length;
        const existing = await this.prisma.agentTrigger.findMany({
          where: { workspaceId, agentKey: spec.agentKey, event: spec.event, projectId: spec.projectId },
          select: { filter: true },
        });
        const unavailable =
          name === null || !projectOk || !connectorsOk ? 'not-found'
          : !isTriggerableAgent(spec.agentKey) || !agentTriggerEventsFor(spec.agentKey).includes(spec.event) ? 'agent-unsupported'
          : !this.triggersOn ? 'triggers-off'
          : existing.some((row) => same(filterOf(row.filter), filter)) ? 'already-configured'
          : null;
        return {
          target: name ?? spec.agentKey,
          diff: created({ event: spec.event, projectId: spec.projectId, ...filter, note: spec.note }),
          unavailable,
          normalized,
        };
      }

      case 'connector-drift-check': {
        const row = await this.prisma.connector.findFirst({ where: { id: spec.connectorId, workspaceId } });
        const before = row ? driftCheckMode(row.config as Record<string, unknown>) : null;
        const unavailable =
          !row ? 'not-found'
          : !DRIFT_KINDS.has(row.kind) ? 'connector-unsupported'
          : before === spec.mode ? 'already-configured'
          : null;
        return { target: row?.name ?? spec.connectorId, diff: [{ field: 'mode', before, after: spec.mode }], unavailable, normalized: spec };
      }

      case 'workflow-draft': {
        const projectOk = await this.projectIn(workspaceId, spec.projectId);
        // `@@unique([workspaceId, name])`: the create would 409.
        const taken = (await this.prisma.workflowDefinition.count({ where: { workspaceId, name: spec.name } })) > 0;
        // `validateGraph` passed at propose and the graph is stored; what can change is whether its templates still exist.
        const broken = (await templateIssues(this.templates, workspaceId, spec.graph)).length > 0;
        const { autoStart, events, categories } = spec.trigger;
        const unavailable =
          !projectOk ? 'not-found' : sectionOff ? 'section-off' : taken ? 'name-taken' : broken ? 'invalid' : null;
        return {
          target: spec.name,
          diff: created({
            name: spec.name,
            description: spec.description,
            projectId: spec.projectId,
            steps: spec.graph.steps.map((step) => step.title),
            autoStart,
            events: autoStart ? events : null,
            categories,
          }),
          unavailable,
          normalized: spec,
        };
      }

      case 'page-template': {
        const projectOk = await this.projectIn(workspaceId, spec.projectId);
        const taken = await this.templates.assertNameFree(workspaceId, spec.projectId, spec.name).then(
          () => false,
          (e: unknown) => {
            if (e instanceof ConflictException) return true;
            throw e;
          },
        );
        const unavailable =
          !projectOk ? 'not-found'
          : sectionOff ? 'section-off'
          : taken ? 'name-taken'
          : null;
        return {
          target: spec.name,
          diff: created({ name: spec.name, description: spec.description, projectId: spec.projectId, source: spec.source }),
          unavailable,
          normalized: spec,
        };
      }
    }
  }

  private async projectIn(workspaceId: string, projectId: string | null): Promise<boolean> {
    return !projectId || (await this.prisma.project.count({ where: { id: projectId, workspaceId } })) > 0;
  }

  private async agentName(workspaceId: string, key: string): Promise<string | null> {
    return this.agents.resolve(workspaceId, key).then((a) => a.name, () => null);
  }

  /** The read tools. Null for a name that is not one. */
  private async read(name: string, workspaceId: string, principal: Principal): Promise<unknown> {
    switch (name) {
      case 'list_agents': {
        const [agents, rows] = await Promise.all([
          this.agents.list(workspaceId),
          this.prisma.aiAgent.findMany({ where: { workspaceId } }),
        ]);
        const byKey = new Map(rows.map((r) => [r.key, r]));
        return agents
          .filter((a) => RUNNABLE_AGENTS.has(a.key) || isTriggerableAgent(a.key))
          .map((a) => {
            const r = byKey.get(a.key);
            return {
              key: a.key,
              name: a.name,
              description: a.description,
              enabled: a.enabled,
              schedulable: RUNNABLE_AGENTS.has(a.key),
              triggerEvents: isTriggerableAgent(a.key) ? agentTriggerEventsFor(a.key) : [],
              schedule: r && (r.scheduleKind || r.scheduleMinutes || r.scheduleTime)
                ? {
                    on: r.scheduleEnabled,
                    kind: scheduleKindOf(r.scheduleKind),
                    minutes: r.scheduleMinutes,
                    time: r.scheduleTime,
                    weekdays: weekdaysOf(r.scheduleWeekdays),
                    timezone: r.scheduleTimezone,
                  }
                : null,
            };
          });
      }
      case 'list_agent_triggers':
        // No note, owner or webhook: the shape a proposal needs, nothing an editor could not otherwise infer.
        return (await this.prisma.agentTrigger.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })).map((r) => ({
          agentKey: r.agentKey,
          event: r.event,
          projectId: r.projectId,
          filter: filterOf(r.filter) satisfies AgentTriggerFilter,
          on: r.enabled,
        }));
      case 'list_projects': {
        const scope = await this.permissions.scopeFor(principal, workspaceId);
        return (await this.projects.list({ workspaceId }, scope)).projects.map((p) => ({ id: p.projectId, name: p.name }));
      }
      case 'list_connectors': {
        const scope = await this.permissions.scopeFor(principal, workspaceId);
        return (await this.connectors.list(scope))
          .filter((c) => DRIFT_KINDS.has(c.kind))
          .map((c) => ({ id: c.id, name: c.name, kind: c.kind, projectId: c.projectId, driftCheck: driftCheckMode(c.config) }));
      }
      case 'list_workflows':
        // Workspace-wide only, as the templates' listing: a restricted project's definitions stay its own.
        return this.prisma.workflowDefinition.findMany({
          where: { workspaceId, projectId: null },
          orderBy: { name: 'asc' },
          select: { name: true, description: true, enabled: true },
        });
      case 'list_templates':
        return (await this.templates.list({ workspaceId })).templates.map((tpl) => ({
          ref: tpl.ref,
          name: tpl.name,
          category: tpl.category,
          description: tpl.description,
        }));
      default:
        return null;
    }
  }

  private async write(
    id: string | null,
    workspaceId: string,
    goal: string,
    changes: ConfigurationChange[],
    userId: string,
  ): Promise<ProposalRow> {
    const json = changes as unknown as Prisma.InputJsonValue;
    return id
      ? this.prisma.configurationProposal.update({ where: { id }, data: { changes: json } })
      : this.prisma.configurationProposal.create({ data: { workspaceId, goal, changes: json, createdBy: userId } });
  }

  isAdmin(principal: Principal, workspaceId: string): Promise<boolean> {
    return this.access.requireRole(principal, workspaceId, 'admin').then(() => true, () => false);
  }
}

/**
 * The role applying a change needs, by its writer's route: a project's page
 * template is `editor` (`templates.controller.ts`), everything else workspace
 * `admin`. Asked again at apply, from the spec, never from the stored row.
 */
export function requiresFor(spec: ConfigurationChangeSpec): 'admin' | 'editor' {
  return spec.kind === 'page-template' && spec.projectId ? 'editor' : 'admin';
}

/** A change that creates something: every field it sets, against nothing today. */
function created(after: Record<string, unknown>): ConfigurationDiffRow[] {
  return Object.entries(after)
    .filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length))
    .map(([field, value]) => ({ field, before: null, after: value }));
}

function tool(name: string, description: string): ChatCompletionFunctionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: false } } };
}

/** One row per field the spec sets, beside what is stored today. */
function diffRows(before: Record<string, unknown>, spec: ConfigurationChangeSpec): ConfigurationDiffRow[] {
  return Object.keys(before)
    .map((field) => ({ field, before: before[field] ?? null, after: (spec as unknown as Record<string, unknown>)[field] ?? null }))
    // A field neither side sets (an interval's minutes on a weekly schedule) is not part of the change.
    .filter((row) => row.before !== null || row.after !== null);
}

/** Structural equality of two JSON values; key order does not count (jsonb reorders keys). */
export function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a ?? null, b ?? null);
}

export function changesOf(row: ProposalRow): ConfigurationChange[] {
  return Array.isArray(row.changes) ? (row.changes as unknown as ConfigurationChange[]) : [];
}

export function toProposal(row: ProposalRow): ConfigurationProposal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    goal: row.goal,
    summary: row.summary,
    changes: changesOf(row),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
