import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { AgentTrigger } from '@prisma/client';
import { agentTriggerEventFor, type KnowledgeEvent } from '@knowledge/contracts';
import {
  AgentTriggerService,
  matchesTrigger,
  type TriggerFacts,
} from '../src/agents/agent-trigger.service.js';
import { AgentTriggerListener } from '../src/agents/agent-trigger.listener.js';
import { mergeFilter } from '../src/ai/agent-triggers.service.js';

/**
 * Event-triggered agent runs (#70, phase 2): every guard on its own, the
 * cooldown, and the listener's two departures from WorkflowTriggerService —
 * an event with no `documentId` still fires, an agent's own events never do.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-15T12:00:00Z');

interface Run {
  id: string;
  workspaceId: string;
  agentKey: string;
  trigger: string;
  triggerId: string | null;
  subjectKey: string | null;
  status: string;
  createdAt: Date;
  createdBy?: string;
  locale?: string;
  input?: Record<string, any> | null;
}

const trigger = (over: Partial<AgentTrigger> = {}): AgentTrigger => ({
  id: 't-1',
  workspaceId: WS,
  projectId: null,
  agentKey: 'glossarist',
  event: 'page.merged',
  filter: {},
  enabled: true,
  ownerId: OWNER,
  cooldownMinutes: 60,
  note: null,
  lastFiredAt: null,
  createdBy: OWNER,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

const merged = (over: Partial<TriggerFacts> = {}): TriggerFacts => ({
  workspaceId: WS,
  event: { type: 'page.merged', source: 'merge-request.merged', subjectId: 'mr-1', documentId: PAGE },
  subjectKey: `doc:${PAGE}`,
  projectId: 'p-1',
  category: 'guide',
  branch: 'main',
  defaultBranch: true,
  ...over,
});

/** Just the agent_runs operators the service emits, over an in-memory table. */
function matches(run: Run, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'status') return (want.in as string[]).includes(run.status);
    if (key === 'createdAt') return run.createdAt >= want.gte;
    if (key === 'input') return run.input?.event?.[want.path[1]] === want.equals;
    return (run as any)[key] === want;
  });
}

function harness(opts: {
  runs?: Run[];
  agent?: Record<string, unknown> | null;
  overBudget?: boolean;
  maxActive?: number;
} = {}) {
  const runs: Run[] = [...(opts.runs ?? [])];
  const prisma: any = {
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    agentRun: {
      count: vi.fn(async ({ where }: { where: Record<string, any> }) => runs.filter((r) => matches(r, where)).length),
      create: vi.fn(async ({ data }: { data: Omit<Run, 'id' | 'status' | 'createdAt'> }) => {
        const run = { ...data, id: `run-${runs.length + 1}`, status: 'pending', createdAt: NOW } as Run;
        runs.push(run);
        return { id: run.id };
      }),
    },
    agentTrigger: { update: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ locale: 'ru' })) },
    aiAgent: { findUnique: vi.fn(async () => null) },
  };
  const agent =
    opts.agent === null ? null : { name: 'Glossarist', enabled: true, surfaces: ['chat', 'background'], ...opts.agent };
  const registry = {
    resolve: vi.fn(async () => {
      if (!agent) throw new Error('unknown agent');
      return agent;
    }),
  };
  const usage = {
    assertWithinBudget: vi.fn(async () => {
      if (opts.overBudget) throw new Error('over budget');
    }),
  };
  const producer = { enqueue: vi.fn(async () => undefined) };
  const activity = { record: vi.fn(async () => undefined) };
  const config = { get: vi.fn((key: string) => (key === 'AGENT_TRIGGER_MAX_ACTIVE' ? (opts.maxActive ?? 5) : undefined)) };
  const service = new AgentTriggerService(
    prisma,
    registry as never,
    usage as never,
    producer as never,
    activity as never,
    config as never,
  );
  return { service, runs, prisma, producer, activity, usage };
}

const run = (over: Partial<Run>): Run => ({
  id: 'old',
  workspaceId: WS,
  agentKey: 'glossarist',
  trigger: 'event',
  triggerId: 't-1',
  subjectKey: `doc:${PAGE}`,
  status: 'succeeded',
  createdAt: new Date(NOW.getTime() - 3 * 3_600_000),
  ...over,
});

describe('AgentTriggerService.fire', () => {
  it('starts one page-scoped event run owned by the trigger owner', async () => {
    const { service, runs, producer, activity } = harness();
    const outcome = await service.fire(trigger({ note: 'Glossary only.' }), merged(), NOW);

    expect(outcome).toEqual({ started: true, runId: 'run-1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'event',
      triggerId: 't-1',
      subjectKey: `doc:${PAGE}`,
      createdBy: OWNER,
      locale: 'ru',
      input: {
        note: 'Glossary only.',
        documentIds: [PAGE],
        event: { type: 'page.merged', source: 'merge-request.merged', documentId: PAGE },
      },
    });
    expect(producer.enqueue).toHaveBeenCalledWith('run-1');
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.trigger.fired', subjectId: 'run-1', documentId: PAGE, actor: OWNER }),
    );
  });

  it('merging again within the cooldown starts nothing; after it, one more', async () => {
    const { service, runs } = harness();
    await service.fire(trigger(), merged(), NOW);
    runs[0].status = 'succeeded';

    const soon = new Date(NOW.getTime() + 30 * 60_000);
    expect(await service.fire(trigger(), merged(), soon)).toEqual({ started: false, reason: 'cooldown' });
    const later = new Date(NOW.getTime() + 61 * 60_000);
    expect((await service.fire(trigger(), merged(), later)).started).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('a cooldown of 0 is off', async () => {
    const { service } = harness({ runs: [run({ createdAt: NOW })] });
    expect((await service.fire(trigger({ cooldownMinutes: 0 }), merged(), NOW)).started).toBe(true);
  });

  describe('each guard on its own', () => {
    it('a disabled trigger', async () => {
      const { service, runs } = harness();
      expect(await service.fire(trigger({ enabled: false }), merged(), NOW)).toEqual({ started: false, reason: 'disabled' });
      expect(runs).toHaveLength(0);
    });

    it('a trigger from another workspace', async () => {
      const { service } = harness();
      const other = trigger({ workspaceId: '44444444-4444-4444-8444-444444444444' });
      expect(await service.fire(other, merged(), NOW)).toEqual({ started: false, reason: 'disabled' });
    });

    it('a filter miss', async () => {
      const { service } = harness();
      const t = trigger({ filter: { categories: ['runbook'] } });
      expect(await service.fire(t, merged(), NOW)).toEqual({ started: false, reason: 'filter' });
    });

    it('a run already in flight for the subject — from any trigger, or by hand', async () => {
      const { service } = harness({ runs: [run({ triggerId: null, trigger: 'manual', status: 'running' })] });
      expect(await service.fire(trigger(), merged(), NOW)).toEqual({ started: false, reason: 'in-flight' });
    });

    it('an in-flight run for another subject does not block this one', async () => {
      const { service } = harness({ runs: [run({ subjectKey: 'doc:other', status: 'running' })] });
      expect((await service.fire(trigger(), merged(), NOW)).started).toBe(true);
    });

    it('AGENT_TRIGGER_MAX_ACTIVE reached, with a warning', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const inFlight = [1, 2].map((i) => run({ id: `r${i}`, subjectKey: `doc:${i}`, agentKey: 'curator', status: 'pending' }));
      const { service } = harness({ runs: inFlight, maxActive: 2 });
      expect(await service.fire(trigger(), merged(), NOW)).toEqual({ started: false, reason: 'cap' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 triggered runs already in flight'));
      warn.mockRestore();
    });

    it('no owner, with a warning — never started under nobody', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, runs } = harness();
      expect(await service.fire(trigger({ ownerId: null }), merged(), NOW)).toEqual({ started: false, reason: 'no-owner' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no owner'));
      expect(runs).toHaveLength(0);
      warn.mockRestore();
    });

    it('a disabled agent, or one with no background executor', async () => {
      expect(await harness({ agent: { enabled: false } }).service.fire(trigger(), merged(), NOW)).toEqual({
        started: false,
        reason: 'agent-unavailable',
      });
      const sentinel = trigger({ agentKey: 'sentinel' });
      expect(await harness().service.fire(sentinel, merged(), NOW)).toEqual({ started: false, reason: 'agent-unavailable' });
    });

    it('over budget', async () => {
      const { service } = harness({ overBudget: true });
      expect(await service.fire(trigger(), merged(), NOW)).toEqual({ started: false, reason: 'budget' });
    });

    it('a repository reader on an event that names no repository', async () => {
      const { service } = harness();
      const t = trigger({ agentKey: 'archaeologist', event: 'connector.synced' });
      const facts = connectorFacts({ repoConnector: false });
      expect(await service.fire(t, facts, NOW)).toEqual({ started: false, reason: 'no-scope' });
    });
  });

  describe('page.indexed', () => {
    const indexed = (revisionId: string, occurredAt = NOW): TriggerFacts =>
      merged({
        event: { type: 'page.indexed', source: 'revision.indexed', documentId: PAGE, revisionId },
        occurredAt,
      });
    const onIndex = trigger({ event: 'page.indexed', cooldownMinutes: 0 });

    it('a re-index of the same revision is the same news', async () => {
      const { service, runs } = harness();
      expect((await service.fire(onIndex, indexed('rev-1'), NOW)).started).toBe(true);
      runs[0].status = 'succeeded';
      expect(await service.fire(onIndex, indexed('rev-1'), NOW)).toEqual({ started: false, reason: 'already-seen' });
      expect((await service.fire(onIndex, indexed('rev-2'), NOW)).started).toBe(true);
    });

    it('a revision older than the trigger is not news to it', async () => {
      const { service } = harness();
      const old = indexed('rev-0', new Date('2026-09-01T00:00:00Z'));
      expect(await service.fire(onIndex, old, NOW)).toEqual({ started: false, reason: 'already-seen' });
    });
  });

  it('a connector sync names the repository for a connector-scoped agent and no pages', async () => {
    const { service, runs } = harness();
    const t = trigger({ agentKey: 'archaeologist', event: 'connector.synced' });
    expect((await service.fire(t, connectorFacts(), NOW)).started).toBe(true);
    expect(runs[0].subjectKey).toBe('connector:c-1');
    expect(runs[0].input).toEqual({
      connectorId: 'c-1',
      event: { type: 'connector.synced', source: 'connector.run.succeeded', subjectId: 'c-1' },
    });
  });
});

function connectorFacts(over: Partial<TriggerFacts> = {}): TriggerFacts {
  return {
    workspaceId: WS,
    event: { type: 'connector.synced', source: 'connector.run.succeeded', subjectId: 'c-1' },
    subjectKey: 'connector:c-1',
    projectId: 'p-1',
    connectorId: 'c-1',
    repoConnector: true,
    ...over,
  };
}

describe('matchesTrigger', () => {
  it('an absent field matches everything; a present one must hold', () => {
    expect(matchesTrigger(trigger(), merged())).toBe(true);
    expect(matchesTrigger(trigger({ projectId: 'p-2' }), merged())).toBe(false);
    expect(matchesTrigger(trigger({ filter: { categories: ['guide'] } }), merged())).toBe(true);
    expect(matchesTrigger(trigger({ filter: { branch: 'release' } }), merged())).toBe(false);
    expect(matchesTrigger(trigger({ filter: { branch: 'release' } }), merged({ branch: 'release' }))).toBe(true);
  });

  it('an event without the filtered dimension does not satisfy it', () => {
    const synced = trigger({ event: 'connector.synced', filter: { categories: ['guide'] } });
    expect(matchesTrigger(synced, connectorFacts())).toBe(false);
    const internal = trigger({ event: 'merge-request.opened', filter: { connectorIds: ['c-1'] } });
    const mr = merged({ event: { type: 'merge-request.opened', source: 'merge-request.created', documentId: PAGE } });
    expect(matchesTrigger(internal, mr)).toBe(false);
  });

  it('page.indexed hears only the default branch unless a branch is named', () => {
    const t = trigger({ event: 'page.indexed' });
    const draft = merged({
      event: { type: 'page.indexed', source: 'revision.indexed', documentId: PAGE, revisionId: 'r' },
      branch: 'draft',
      defaultBranch: false,
    });
    expect(matchesTrigger(t, draft)).toBe(false);
    expect(matchesTrigger(t, { ...draft, branch: 'main', defaultBranch: true })).toBe(true);
    expect(matchesTrigger(trigger({ event: 'page.indexed', filter: { branch: 'draft' } }), draft)).toBe(true);
  });
});

describe('mergeFilter', () => {
  it('absent keeps, null clears, and fields the event has no dimension for are dropped', () => {
    const stored = { categories: ['guide'], branch: 'main' };
    expect(mergeFilter('page.merged', stored, {})).toEqual(stored);
    expect(mergeFilter('page.merged', stored, { branch: null })).toEqual({ categories: ['guide'] });
    expect(mergeFilter('connector.synced', {}, { categories: ['guide'], connectorIds: ['c-1'] })).toEqual({
      connectorIds: ['c-1'],
    });
  });
});

describe('AgentTriggerListener', () => {
  function listener(prismaOver: Record<string, unknown>) {
    const prisma = {
      agentTrigger: { findMany: vi.fn(async () => [trigger({ event: 'connector.synced', agentKey: 'archaeologist' })]) },
      ...prismaOver,
    };
    const fire = vi.fn(async () => ({ started: true, runId: 'r' }));
    const l = new AgentTriggerListener(prisma as never, {} as never, { fire } as never, {} as never);
    return { l, prisma, fire };
  }
  const event = (over: Partial<KnowledgeEvent>): KnowledgeEvent => ({ type: 'x', workspaceId: WS, at: NOW.toISOString(), ...over });

  it('fires connector.synced although the event carries no documentId', async () => {
    const { l, fire } = listener({
      connector: {
        findUnique: vi.fn(async () => ({ id: 'c-1', workspaceId: WS, projectId: 'p-1', kind: 'codebase' })),
      },
    });
    await l.handle(event({ type: 'connector.run.succeeded', subjectId: 'c-1' }));
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connector.synced' }),
      expect.objectContaining({ subjectKey: 'connector:c-1', connectorId: 'c-1', repoConnector: true }),
    );
  });

  it('an agent run’s own events never start a run', async () => {
    const { l, prisma, fire } = listener({});
    for (const type of ['agent.run.succeeded', 'agent.trigger.fired', 'agent.run.failed', 'workflow-run.completed']) {
      expect(agentTriggerEventFor(type)).toBeNull();
      await l.handle(event({ type, documentId: PAGE }));
    }
    expect(prisma.agentTrigger.findMany).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it('a connector from another workspace is not heard', async () => {
    const { l, fire } = listener({
      connector: { findUnique: vi.fn(async () => ({ id: 'c-1', workspaceId: 'elsewhere', projectId: 'p', kind: 'codebase' })) },
    });
    await l.handle(event({ type: 'connector.run.succeeded', subjectId: 'c-1' }));
    expect(fire).not.toHaveBeenCalled();
  });
});
