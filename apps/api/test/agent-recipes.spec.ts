import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AgentTrigger, AiAgent } from '@prisma/client';
import { AGENT_RECIPES, AGENT_RECIPE_KEYS, BUILT_IN_AGENT_KEYS, nextScheduledRun } from '@knowledge/contracts';
import { AgentRecipesService } from '../src/ai/agent-recipes.service.js';
import { AiAgentsService } from '../src/ai/ai-agents.service.js';
import { AgentTriggersService } from '../src/ai/agent-triggers.service.js';
import { RUNNABLE_AGENTS } from '../src/agents/agent.executor.js';
import { BUILT_IN_AGENT_DEFAULTS } from '../src/agents/built-in-agents.js';
import {
  DIGEST_DEFAULT_DAYS,
  DIGEST_MAX_DAYS,
  digestKnown,
  digestListing,
  digestMarkdown,
  digestSince,
  isQuietDigest,
  keepKnownLinks,
  readDigestHighlights,
  type DigestFacts,
} from '../src/agents/digest.js';

/**
 * Recipes and the digest agent (#70, phase 4). Applying a recipe goes through
 * the real AiAgentsService and AgentTriggersService over an in-memory prisma,
 * so the defaults those apply (disabled, no owner until enabled) are the ones
 * asserted here rather than a copy of them.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const CALLER = '33333333-3333-4333-8333-333333333333';

function harness() {
  const agents = new Map<string, AiAgent>();
  const triggers: AgentTrigger[] = [];
  let seq = 0;
  const prisma = {
    aiAgent: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_key: { key: string } } }) => agents.get(where.workspaceId_key.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { workspaceId_key: { key: string } }; create: Partial<AiAgent>; update: Partial<AiAgent> }) => {
        const key = where.workspaceId_key.key;
        const existing = agents.get(key);
        const row = existing ? { ...existing, ...update } : (blankAgent({ ...create, key }) as AiAgent);
        agents.set(key, row as AiAgent);
        return row;
      }),
    },
    agentTrigger: {
      findMany: vi.fn(async ({ where }: { where: { agentKey: string; event: string } }) =>
        triggers.filter((t) => t.agentKey === where.agentKey && t.event === where.event),
      ),
      create: vi.fn(async ({ data }: { data: Partial<AgentTrigger> }) => {
        const row = {
          id: `trigger-${++seq}`,
          projectId: null,
          filter: {},
          note: null,
          webhookSecret: null,
          lastFiredAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as AgentTrigger;
        triggers.push(row);
        return row;
      }),
    },
  };
  const registry = {
    resolve: vi.fn(async (_ws: string, key: string) => resolved(key)),
    invalidate: vi.fn(),
  };
  const config = { get: (k: string) => ({ AGENT_TRIGGER_COOLDOWN_MINUTES: 60, AGENT_TRIGGERS_ENABLED: true, API_PUBLIC_URL: 'http://api' })[k] };
  const agentsService = new AiAgentsService(prisma as never, registry as never, {} as never);
  const triggersService = new AgentTriggersService(prisma as never, registry as never, config as never);
  const service = new AgentRecipesService(prisma as never, agentsService, triggersService);
  return { service, agents, triggers, prisma };
}

function blankAgent(over: Partial<AiAgent>): Partial<AiAgent> {
  return {
    id: `agent-${over.key}`,
    workspaceId: WS,
    builtIn: true,
    name: null,
    description: null,
    instructions: null,
    tools: null,
    skillIds: null,
    providerId: null,
    temperature: null,
    maxToolCalls: null,
    timeoutMs: null,
    enabled: true,
    scheduleEnabled: false,
    scheduleKind: null,
    scheduleMinutes: null,
    scheduleTime: null,
    scheduleWeekdays: null,
    scheduleTimezone: null,
    scheduleNote: null,
    scheduleOwner: null,
    scheduleChangedAt: null,
    lastRunAt: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Partial<AiAgent>;
}

function resolved(key: string) {
  return {
    key,
    builtIn: true,
    name: key,
    description: '',
    instructions: '',
    tools: [],
    skillIds: [],
    config: { providerId: null, providerName: null, temperature: 0, maxToolCalls: 0, timeoutMs: 0, enabled: true },
    surfaces: ['background'],
    requires: [],
    missing: [],
    purpose: 'review',
    enabled: true,
  };
}

describe('the recipe catalogue', () => {
  it('names only built-in agents that have an executor', () => {
    for (const key of AGENT_RECIPE_KEYS) {
      const recipe = AGENT_RECIPES[key];
      expect(recipe.key).toBe(key);
      expect(BUILT_IN_AGENT_KEYS).toContain(recipe.agentKey);
      expect(RUNNABLE_AGENTS.has(recipe.agentKey)).toBe(true);
    }
  });

  it('gives every built-in agent, the digest included, a registry default', () => {
    expect(BUILT_IN_AGENT_DEFAULTS.digest.surfaces).toEqual(['background']);
  });

  it('spells a schedule the predicate can fire', () => {
    const spec = AGENT_RECIPES['weekly-digest'].schedule!;
    const next = nextScheduledRun(
      { kind: spec.kind, minutes: null, time: spec.time, weekdays: spec.weekdays ?? null, timezone: 'Europe/Moscow' },
      { lastRunAt: null, changedAt: new Date('2026-10-15T12:00:00Z') },
      new Date('2026-10-15T12:00:00Z'),
    );
    // Monday 19 October, 09:00 in Moscow.
    expect(next?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
  });
});

describe('AgentRecipesService.apply', () => {
  it('writes the weekly digest schedule disabled, with no owner until someone enables it', async () => {
    const { service, agents } = harness();
    const res = await service.apply('weekly-digest', { workspaceId: WS, timezone: 'Europe/Moscow' }, CALLER);

    expect(res.created).toEqual({ schedule: true, triggers: 0 });
    const row = agents.get('digest')!;
    expect(row).toMatchObject({
      scheduleEnabled: false,
      scheduleOwner: null,
      scheduleKind: 'weekly',
      scheduleTime: '09:00',
      scheduleWeekdays: [1],
      scheduleTimezone: 'Europe/Moscow',
      createdBy: CALLER,
    });
    expect(res.agent.scheduleEnabled).toBe(false);
    // Disabled: nothing will start, so there is no next run to show.
    expect(res.agent.nextRunAt).toBeNull();
  });

  it('creates a disabled, ownerless trigger attributed to the caller', async () => {
    const { service, triggers } = harness();
    const res = await service.apply('glossary-suggester', { workspaceId: WS }, CALLER);

    expect(res.created).toEqual({ schedule: false, triggers: 1 });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      agentKey: 'glossarist',
      event: 'page.merged',
      enabled: false,
      ownerId: null,
      createdBy: CALLER,
      cooldownMinutes: 60,
    });
    expect(triggers[0].note).toMatch(/glossary/i);
    expect(res.triggers.map((t) => t.id)).toEqual([triggers[0].id]);
  });

  it('writes both halves of the freshness sweep', async () => {
    const { service, agents, triggers } = harness();
    const res = await service.apply('freshness-sweep', { workspaceId: WS }, CALLER);

    expect(res.created).toEqual({ schedule: true, triggers: 1 });
    expect(agents.get('curator')).toMatchObject({ scheduleEnabled: false, scheduleKind: 'weekly', scheduleTimezone: null });
    // t() returns the key outside a locale context; either way a note is seeded.
    expect(agents.get('curator')!.scheduleNote).toMatch(/freshness|stale/i);
    expect(triggers[0]).toMatchObject({ agentKey: 'curator', event: 'connector.synced', enabled: false });
  });

  it('is idempotent: a second apply writes nothing and reports what is there', async () => {
    const { service, triggers, prisma } = harness();
    await service.apply('freshness-sweep', { workspaceId: WS }, CALLER);
    const upserts = prisma.aiAgent.upsert.mock.calls.length;

    const again = await service.apply('freshness-sweep', { workspaceId: WS }, CALLER);
    expect(again.created).toEqual({ schedule: false, triggers: 0 });
    expect(prisma.aiAgent.upsert.mock.calls.length).toBe(upserts);
    expect(triggers).toHaveLength(1);
    expect(again.triggers.map((t) => t.id)).toEqual([triggers[0].id]);
  });

  it('keeps a schedule an admin already set, enabled or not', async () => {
    const { service, agents } = harness();
    agents.set(
      'digest',
      blankAgent({ key: 'digest', scheduleEnabled: true, scheduleMinutes: 1440, scheduleOwner: CALLER }) as AiAgent,
    );
    const res = await service.apply('weekly-digest', { workspaceId: WS }, CALLER);

    expect(res.created.schedule).toBe(false);
    expect(agents.get('digest')).toMatchObject({ scheduleEnabled: true, scheduleMinutes: 1440, scheduleKind: null });
  });

  it('refuses an unknown recipe and an unknown timezone', async () => {
    const { service } = harness();
    await expect(service.apply('nightly-chaos', { workspaceId: WS }, CALLER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.apply('weekly-digest', { workspaceId: WS, timezone: 'Mars/Olympus' }, CALLER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GHOST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const facts = (over: Partial<DigestFacts> = {}): DigestFacts => ({
  since: new Date('2026-10-08T09:00:00Z'),
  until: new Date('2026-10-15T09:00:00Z'),
  created: [{ id: A, title: 'Billing [v2]', category: 'architecture', createdAt: new Date('2026-10-10T10:00:00Z') }],
  changed: [{ id: B, title: 'Runbook', category: 'process', revisions: 3 }],
  merged: [{ title: 'Clarify retries', mergedAt: new Date('2026-10-12T10:00:00Z'), document: { id: C, title: 'Retries', category: 'guide' } }],
  findings: [{ agent: 'Curator', count: 4 }],
  ...over,
});

const LABELS = {
  highlights: 'Highlights',
  created: 'New pages',
  changed: 'Changed pages',
  merged: 'Merged changes',
  findings: 'Agent findings',
  revisions: (n: number) => `${n} revisions`,
};

describe('the digest window', () => {
  const now = new Date('2026-10-15T09:00:00Z');

  it('starts at the previous digest', () => {
    const previous = new Date('2026-10-12T09:00:00Z');
    expect(digestSince(previous, now)).toEqual(previous);
  });

  it('defaults to a week without one, and never reaches further back than the cap', () => {
    expect(now.getTime() - digestSince(null, now).getTime()).toBe(DIGEST_DEFAULT_DAYS * 86_400_000);
    expect(now.getTime() - digestSince(new Date('2026-01-01T00:00:00Z'), now).getTime()).toBe(DIGEST_MAX_DAYS * 86_400_000);
  });
});

describe('the digest cites only pages that exist', () => {
  const known = digestKnown(facts());

  it('knows exactly the pages the facts name', () => {
    expect([...known.keys()].sort()).toEqual([A, B, C].sort());
  });

  it('drops a highlight that cites no listed page, and an invented id from one that does', () => {
    const highlights = readDigestHighlights(
      {
        highlights: [
          { title: 'Invented', detail: 'About a page that is not there', documentIds: [GHOST] },
          { title: 'Billing', detail: 'A new design', documentIds: [A, GHOST] },
          { title: 'No detail', documentIds: [B] },
        ],
      },
      known,
    );
    expect(highlights).toEqual([{ title: 'Billing', detail: 'A new design', documentIds: [A] }]);
  });

  it('unlinks a page link the model invented and keeps a real one', () => {
    expect(keepKnownLinks(`See [ghost](/documents/${GHOST}) and [runbook](/documents/${B}).`, known)).toBe(
      `See ghost and [runbook](/documents/${B}).`,
    );
  });

  it('builds every list and link in the page from the facts', () => {
    const md = digestMarkdown(
      facts(),
      `A busy week. Also [nothing](/documents/${GHOST}).`,
      [{ title: 'Billing', detail: 'A new design', documentIds: [A] }],
      LABELS,
    );
    const linked = [...md.matchAll(/\]\(\/documents\/([^)]+)\)/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    for (const id of linked) expect(known.has(id)).toBe(true);
    expect(md).not.toContain(GHOST);
    expect(md).toContain('## New pages');
    expect(md).toContain(`[Billing \\[v2\\]](/documents/${A})`);
    expect(md).toContain('3 revisions');
    expect(md).toContain('Clarify retries (2026-10-12)');
    expect(md).toContain('- Curator: 4');
  });

  it('shows the model the ids it may cite', () => {
    const listing = digestListing(facts());
    for (const id of [A, B, C]) expect(listing).toContain(id);
    expect(listing).toContain('Period: 2026-10-08 to 2026-10-15.');
  });

  it('calls a period with nothing in it quiet', () => {
    expect(isQuietDigest(facts({ created: [], changed: [], merged: [], findings: [] }))).toBe(true);
    expect(isQuietDigest(facts())).toBe(false);
  });
});
