import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentTrigger, Prisma } from '@prisma/client';
import {
  isConnectorScopedAgent,
  isPageScopedAgent,
  type AgentRunEvent,
  type AgentRunInput,
  type AgentTriggerFilter,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { asLocale } from '../i18n/locale.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AgentRegistryService } from './agent-registry.service.js';
import { AgentProducer } from './agent.producer.js';
import { RUNNABLE_AGENTS } from './agent.executor.js';

/**
 * What the listener learned about one event, resolved against PostgreSQL —
 * everything a trigger's filter and guards read, and nothing they would have
 * to look up again per trigger.
 */
export interface TriggerFacts {
  workspaceId: string;
  event: AgentRunEvent;
  /** `doc:<id>`, `mr:<id>`, `connector:<id>` — what the in-flight and cooldown guards key on. */
  subjectKey: string;
  projectId: string | null;
  /** The page's category; absent for an event about no page. */
  category?: string | null;
  connectorId?: string | null;
  /** The connector is a repository — the only kind a connector-scoped agent reads. */
  repoConnector?: boolean;
  /** See {@link AgentTriggerFilter.branch}. */
  branch?: string | null;
  defaultBranch?: boolean;
  /**
   * When the subject came to be — a revision's creation. One that predates the
   * trigger is not news to it: a re-index of an old page is not "it changed".
   */
  occurredAt?: Date;
  /** A webhook body, kept on the run as `input.payload` (already cut to size). */
  payload?: string;
}

/**
 * Who a run is for when it is not the trigger's owner. A mention is somebody
 * addressing the agent: the run executes and bills as them, in their language,
 * and they have already been checked for the role the run needs.
 */
export interface FireOptions {
  ownerId?: string;
  locale?: string;
}

/** Why a trigger started nothing. Each is one guard, and each is observable on its own. */
export type TriggerSkip =
  | 'disabled'
  | 'filter'
  | 'no-owner'
  | 'agent-unavailable'
  | 'no-scope'
  | 'already-seen'
  | 'budget'
  | 'in-flight'
  | 'cooldown'
  | 'cap';

export type TriggerOutcome = { started: true; runId: string } | { started: false; reason: TriggerSkip };

/** Lifetime of an `'event'` run the cap counts; a terminal run no longer holds a slot. */
const IN_FLIGHT = ['pending', 'running'];

/**
 * Starts agent runs from events (#70) — the only writer of `trigger: 'event'`.
 *
 * Its guards are WorkflowTriggerService's, for the reason they exist there: the
 * failure mode of an always-on trigger is an LLM avalanche, one busy page fanning
 * out into model calls on every edit. Applied in order, none optional:
 *
 *   1. the trigger is enabled (off on creation) and the event is in its filter;
 *   2. it has an owner — the identity the run executes and bills as. Without one
 *      it is skipped, never started under nobody (`AiAgent.scheduleOwner`). A
 *      mention passes the commenter instead ({@link FireOptions});
 *   3. the agent is enabled and has a background executor;
 *   4. no run of this agent is pending or running for the same subject;
 *   5. `AGENT_TRIGGER_MAX_ACTIVE` triggered runs in flight per workspace.
 *
 * Plus the month's budget at enqueue (the processor checks again), and a
 * cooldown per (trigger, subject) in place of workflows' "once per page":
 * that guard stops a run's own output re-triggering it, and an agent run
 * writes no pages — it proposes — so the chain cannot feed itself. The cooldown
 * bounds the far side instead: a page merged ten times in an hour is one run.
 * Self-trigger suppression is structural for the same reason: the listener
 * hears four bus types and no `agent.*` event is among them, and the other two
 * callers — a signed webhook and a mention — are a person or a system outside.
 * A webhook delivery is deduplicated for good, not just while in flight: its
 * subject is the delivery id, and a sender retrying one must not start two.
 *
 * Guards 4 and 5 are read and the run written under one advisory lock per
 * workspace, so two events landing together cannot both pass them.
 */
@Injectable()
export class AgentTriggerService {
  private readonly logger = new Logger(AgentTriggerService.name);
  private readonly maxActive: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly producer: AgentProducer,
    private readonly activity: ActivityService,
    config: ConfigService<Env, true>,
  ) {
    this.maxActive = Number(config.get('AGENT_TRIGGER_MAX_ACTIVE', { infer: true }) ?? 5);
  }

  async fire(
    trigger: AgentTrigger,
    facts: TriggerFacts,
    now = new Date(),
    options: FireOptions = {},
  ): Promise<TriggerOutcome> {
    if (!trigger.enabled || trigger.workspaceId !== facts.workspaceId) return skip('disabled');
    if (!matchesTrigger(trigger, facts)) return skip('filter');
    const label = `${trigger.agentKey} on ${facts.event.type} (${trigger.id})`;

    const ownerId = options.ownerId ?? trigger.ownerId;
    if (!ownerId) {
      this.logger.warn(`Trigger skipped for ${label}: it has no owner to run as`);
      return skip('no-owner');
    }

    const agent = await this.registry.resolve(trigger.workspaceId, trigger.agentKey).catch(() => null);
    if (!agent?.enabled || !agent.surfaces.includes('background') || !RUNNABLE_AGENTS.has(trigger.agentKey)) {
      this.logger.warn(`Trigger skipped for ${label}: the agent is disabled or cannot run in the background`);
      return skip('agent-unavailable');
    }

    // A connector-scoped agent reads one repository, and only an event about
    // one names it; anything else would make the run fail in the worker.
    const connectorScoped = isConnectorScopedAgent(trigger.agentKey);
    if (connectorScoped && !(facts.connectorId && facts.repoConnector)) {
      this.logger.warn(`Trigger skipped for ${label}: the event names no repository for this agent to read`);
      return skip('no-scope');
    }
    if (facts.occurredAt && facts.occurredAt < trigger.createdAt) return skip('already-seen');

    try {
      await this.usage.assertWithinBudget(trigger.workspaceId, ownerId);
    } catch {
      this.logger.warn(`Trigger skipped for ${label}: the workspace or its owner is over budget`);
      return skip('budget');
    }

    const documentId = facts.event.documentId;
    const input: AgentRunInput = {
      ...(trigger.note ? { note: trigger.note } : {}),
      ...(documentId && isPageScopedAgent(trigger.agentKey) ? { documentIds: [documentId] } : {}),
      ...(connectorScoped && facts.connectorId ? { connectorId: facts.connectorId } : {}),
      event: facts.event,
      ...(facts.payload ? { payload: facts.payload } : {}),
    };
    const owner = options.locale
      ? { locale: options.locale }
      : await this.prisma.user.findUnique({ where: { id: ownerId }, select: { locale: true } });
    const agentRow = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId: trigger.workspaceId, key: trigger.agentKey } },
      select: { id: true },
    });

    const result = await this.prisma.$transaction(async (tx): Promise<TriggerOutcome> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-trigger:${trigger.workspaceId}`}))`;

      // A re-index of the same revision is the same news.
      if (facts.event.revisionId) {
        const seen = await tx.agentRun.count({
          where: { triggerId: trigger.id, input: { path: ['event', 'revisionId'], equals: facts.event.revisionId } },
        });
        if (seen > 0) return skip('already-seen');
      }
      // A retried delivery is the same delivery, however long after the first.
      if (facts.event.deliveryId) {
        const seen = await tx.agentRun.count({ where: { triggerId: trigger.id, subjectKey: facts.subjectKey } });
        if (seen > 0) return skip('already-seen');
      }
      const inFlight = await tx.agentRun.count({
        where: {
          workspaceId: trigger.workspaceId,
          agentKey: trigger.agentKey,
          subjectKey: facts.subjectKey,
          status: { in: IN_FLIGHT },
        },
      });
      if (inFlight > 0) return skip('in-flight');
      if (trigger.cooldownMinutes > 0) {
        const recent = await tx.agentRun.count({
          where: {
            triggerId: trigger.id,
            subjectKey: facts.subjectKey,
            createdAt: { gte: new Date(now.getTime() - trigger.cooldownMinutes * 60_000) },
          },
        });
        if (recent > 0) return skip('cooldown');
      }
      const active = await tx.agentRun.count({
        where: { workspaceId: trigger.workspaceId, trigger: 'event', status: { in: IN_FLIGHT } },
      });
      if (active >= this.maxActive) return skip('cap');

      const run = await tx.agentRun.create({
        data: {
          workspaceId: trigger.workspaceId,
          agentKey: trigger.agentKey,
          agentId: agentRow?.id ?? null,
          trigger: 'event',
          triggerId: trigger.id,
          subjectKey: facts.subjectKey,
          createdBy: ownerId,
          // No request to read a language from: the run is written in the
          // owner's, the AgentScheduleSweeper rule.
          locale: asLocale(owner?.locale),
          input: input as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.agentTrigger.update({ where: { id: trigger.id }, data: { lastFiredAt: now } });
      return { started: true, runId: run.id };
    });

    if (!result.started) {
      if (result.reason === 'cap') {
        this.logger.warn(`Trigger skipped for ${label}: ${this.maxActive} triggered runs already in flight`);
      }
      return result;
    }

    await this.producer.enqueue(result.runId);
    void this.activity.record({
      workspaceId: trigger.workspaceId,
      actor: ownerId,
      action: 'agent.trigger.fired',
      ...(documentId ? { documentId } : {}),
      ...(facts.projectId ? { projectId: facts.projectId } : {}),
      subjectId: result.runId,
      metadata: { title: agent.name, agentKey: trigger.agentKey, event: facts.event.type, triggerId: trigger.id },
    });
    this.logger.log(`Started ${label} for ${facts.subjectKey}`);
    return result;
  }
}

function skip(reason: TriggerSkip): TriggerOutcome {
  return { started: false, reason };
}

/**
 * Whether an event is one this trigger listens to. Pure, and the only
 * spelling of the filter's meaning: an absent field matches everything, a
 * present one must hold — an event with no such dimension (a connector sync
 * has no page category) does not satisfy a filter that names one.
 */
export function matchesTrigger(
  trigger: Pick<AgentTrigger, 'event' | 'projectId' | 'filter'>,
  facts: TriggerFacts,
): boolean {
  if (trigger.event !== facts.event.type) return false;
  if (trigger.projectId && trigger.projectId !== facts.projectId) return false;
  const filter = filterOf(trigger.filter);
  if (filter.categories?.length && !(facts.category && filter.categories.includes(facts.category))) return false;
  if (filter.connectorIds?.length && !(facts.connectorId && filter.connectorIds.includes(facts.connectorId))) {
    return false;
  }
  if (filter.branch) return facts.branch === filter.branch;
  // A page indexed on a draft branch is somebody editing, not the page changing.
  if (facts.event.type === 'page.indexed') return facts.defaultBranch === true;
  return true;
}

/** The column is JSON written by the API; anything else in it reads as no filter. */
export function filterOf(value: unknown): AgentTriggerFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : undefined;
  const categories = strings(raw.categories);
  const connectorIds = strings(raw.connectorIds);
  return {
    ...(categories?.length ? { categories } : {}),
    ...(connectorIds?.length ? { connectorIds } : {}),
    ...(typeof raw.branch === 'string' && raw.branch ? { branch: raw.branch } : {}),
  };
}
