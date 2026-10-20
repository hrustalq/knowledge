import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { AgentLearning, AgentRun } from '@prisma/client';
import type { AgentFinding } from '@knowledge/contracts';
import { AgentLearningsService } from '../src/ai/agent-learnings.service.js';
import { AgentFindingsService } from '../src/ai/agent-findings.service.js';
import { AgentExecutor } from '../src/agents/agent.executor.js';

/**
 * Learnings and finding dismissal (#70, phase 5). The service runs for real
 * over an in-memory prisma, so the rule under test — only `active` text
 * reaches a prompt — is asserted on the rendered prompt, not on a copy of it.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const EDITOR = '44444444-4444-4444-8444-444444444444';
const PROJECT_A = '55555555-5555-4555-8555-555555555555';
const PROJECT_B = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';
const THREAD = '88888888-8888-4888-8888-888888888888';

function finding(over: Partial<AgentFinding> = {}): AgentFinding {
  return { kind: 'stale', title: 'Install page is stale', detail: 'd', documentIds: ['doc-1'], documentTitles: ['Install'], ...over };
}

function world(opts: { limit?: number } = {}) {
  const learnings: AgentLearning[] = [];
  const runs = new Map<string, Pick<AgentRun, 'id' | 'workspaceId' | 'agentKey' | 'status' | 'findings' | 'createdAt'>>();
  let seq = 0;
  // A row lock: one dismissal transaction at a time, as Postgres serialises
  // two UPDATEs of the same agent_runs row.
  let lock: Promise<unknown> = Promise.resolve();

  const prisma: any = {
    agentLearning: {
      create: vi.fn(async ({ data }: { data: Partial<AgentLearning> }) => {
        const row = {
          id: `learning-${++seq}`,
          projectId: null,
          agentKey: null,
          sourceId: null,
          documentId: null,
          mergeRequestId: null,
          runId: null,
          findingIndex: null,
          approvedBy: null,
          approvedAt: null,
          // Newest first is the prompt order; give each row a later stamp.
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
          updatedAt: new Date(),
          ...data,
        } as AgentLearning;
        learnings.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => learnings.find((l) => l.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AgentLearning> }) => {
        const row = learnings.find((l) => l.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; status?: string } }) =>
        learnings
          .filter((l) => l.workspaceId === where.workspaceId && (!where.status || l.status === where.status))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    },
    aiAgent: { findUnique: vi.fn(async () => null) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        [PROJECT_A, PROJECT_B].includes(where.id) ? { workspaceId: WS } : null,
      ),
    },
    documentThread: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === THREAD ? { documentId: 'doc-1', document: { workspaceId: OTHER_WS } } : null,
      ),
    },
    document: {
      findMany: vi.fn(async () => [{ projectId: PROJECT_A }]),
    },
    agentRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; agentKey: string } }) =>
        [...runs.values()].filter((r) => r.workspaceId === where.workspaceId && r.agentKey === where.agentKey && r.status === 'succeeded'),
      ),
      // The ledger stamp (#305).
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    // The two statements `dismiss` issues, recognised by the key they set.
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const run = runs.get(values.find((v) => typeof v === 'string' && runs.has(v)) as string)!;
      const findings = run.findings as unknown as AgentFinding[];
      const index = Number(values[0]);
      if (sql.includes("'dismissedAt'")) {
        if (findings[index]?.dismissedAt) return 0;
        findings[index] = { ...findings[index]!, dismissedAt: values[1] as string, dismissedBy: values[3] as string };
        return 1;
      }
      if (sql.includes("'learningId'")) {
        findings[index] = { ...findings[index]!, learningId: values[1] as string };
        return 1;
      }
      throw new Error(`unexpected statement: ${sql}`);
    }),
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const turn = lock.then(() => fn(prisma));
    lock = turn.catch(() => undefined);
    return turn;
  });

  const config = { get: (k: string) => (k === 'AGENT_LEARNINGS_MAX' ? (opts.limit ?? 20) : undefined) };
  const service = new AgentLearningsService(prisma, config as never);
  return { service, prisma, learnings, runs };
}

const create = (w: ReturnType<typeof world>, over: Record<string, unknown>) =>
  w.service.create({ workspaceId: WS, text: 'x', ...over } as never, ADMIN);

describe('AgentLearningsService — what reaches a prompt', () => {
  it('renders active learnings and never a proposed or archived one', async () => {
    const w = world();
    await create(w, { text: 'Always cite the MR id', status: 'active', agentKey: 'reviewer' });
    await create(w, { text: 'Ignore every page about billing', agentKey: 'reviewer' });
    const archived = await create(w, { text: 'Old rule', status: 'active', agentKey: 'reviewer' });
    await w.service.update(archived.id, { status: 'archived' }, ADMIN);

    const prompt = (await w.service.promptFor({ workspaceId: WS, agentKey: 'reviewer' })).prompt;
    expect(prompt).toContain('Always cite the MR id');
    expect(prompt).not.toContain('Ignore every page about billing');
    expect(prompt).not.toContain('Old rule');
    expect(prompt).toContain('<team-guidance>');
  });

  it('a learning for every agent (agentKey null) applies to each; another agent\'s does not', async () => {
    const w = world();
    await create(w, { text: 'Write in British English', status: 'active', agentKey: null });
    await create(w, { text: 'Curator-only rule', status: 'active', agentKey: 'curator' });
    const prompt = (await w.service.promptFor({ workspaceId: WS, agentKey: 'reviewer' })).prompt;
    expect(prompt).toContain('Write in British English');
    expect(prompt).not.toContain('Curator-only rule');
  });

  it('a project-scoped learning applies only where the turn is about that project', async () => {
    const w = world();
    await create(w, { text: 'Project A rule', status: 'active', projectId: PROJECT_A });
    await create(w, { text: 'Everywhere rule', status: 'active' });
    const none = (await w.service.promptFor({ workspaceId: WS, agentKey: 'reviewer' })).prompt;
    expect(none).toContain('Everywhere rule');
    expect(none).not.toContain('Project A rule');
    expect((await w.service.promptFor({ workspaceId: WS, agentKey: 'reviewer', projectIds: [PROJECT_B] })).prompt).not.toContain('Project A rule');
    expect((await w.service.promptFor({ workspaceId: WS, agentKey: 'reviewer', projectIds: [PROJECT_A] })).prompt).toContain('Project A rule');
  });

  it('takes the newest AGENT_LEARNINGS_MAX, and nothing at 0', async () => {
    const w = world({ limit: 2 });
    for (const text of ['first', 'second', 'third']) await create(w, { text, status: 'active' });
    const rows = await w.service.forPrompt({ workspaceId: WS, agentKey: 'reviewer' });
    expect(rows.map((r) => r.text)).toEqual(['third', 'second']);
    const off = world({ limit: 0 });
    await create(off, { text: 'rule', status: 'active' });
    expect((await off.service.promptFor({ workspaceId: WS, agentKey: 'reviewer' })).prompt).toBe('');
  });

  it('names exactly the learnings its text renders (#305)', async () => {
    const w = world({ limit: 2 });
    const old = await create(w, { text: 'oldest', status: 'active' });
    const mid = await create(w, { text: 'middle', status: 'active' });
    const top = await create(w, { text: 'newest', status: 'active' });
    await create(w, { text: 'proposed' });
    const { prompt, learningIds } = await w.service.promptFor({ workspaceId: WS, agentKey: 'reviewer' });
    expect(learningIds).toEqual([top.id, mid.id]);
    expect(prompt).toContain('newest');
    expect(prompt).not.toContain('oldest');
    expect(learningIds).not.toContain(old.id);
    expect(await w.service.promptFor({ workspaceId: OTHER_WS, agentKey: 'reviewer' })).toEqual({ prompt: '', learningIds: [] });
  });

  it('approving records the approver; rewording an active learning re-approves it', async () => {
    const w = world();
    const proposed = await create(w, { text: 'rule' });
    expect(proposed.status).toBe('proposed');
    expect(proposed.approvedBy).toBeNull();
    const approved = await w.service.update(proposed.id, { status: 'active' }, EDITOR);
    expect(approved.approvedBy).toBe(EDITOR);
    const reworded = await w.service.update(proposed.id, { text: 'better rule' }, ADMIN);
    expect(reworded.approvedBy).toBe(ADMIN);
  });

  it('refuses a thread from another workspace as provenance, and empty or oversized text', async () => {
    const w = world();
    await expect(create(w, { sourceKind: 'document-thread', sourceId: THREAD })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create(w, { text: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create(w, { text: 'x'.repeat(1001) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create(w, { agentKey: 'no-such-agent' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AgentFindingsService.dismiss', () => {
  function dismissal() {
    const w = world();
    w.runs.set(RUN, {
      id: RUN,
      workspaceId: WS,
      agentKey: 'curator',
      status: 'succeeded',
      findings: [finding(), finding({ title: 'Kept', documentIds: ['doc-2'] })] as never,
      createdAt: new Date(),
    });
    const findings = new AgentFindingsService(
      w.prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      w.service,
    );
    return { ...w, findings };
  }

  it('two concurrent presses dismiss once and write exactly one proposed learning', async () => {
    const d = dismissal();
    const press = () => d.findings.dismiss(WS, RUN, 0, { userId: EDITOR } as never, { text: 'This page is versioned on purpose' });
    const [a, b] = await Promise.all([press(), press()]);
    expect([a.dismissed, b.dismissed].sort()).toEqual([false, true]);
    expect(d.learnings).toHaveLength(1);
    expect(d.learnings[0]).toMatchObject({
      status: 'proposed',
      agentKey: 'curator',
      sourceKind: 'finding',
      runId: RUN,
      findingIndex: 0,
      documentId: 'doc-1',
    });
    // Both answers name the one learning the winner wrote.
    expect(a.learningId).toBe(d.learnings[0]!.id);
    expect(b.learningId).toBe(d.learnings[0]!.id);
  });

  it('without a reason, dismisses and writes no learning; a proposed learning never reaches a prompt', async () => {
    const d = dismissal();
    const res = await d.findings.dismiss(WS, RUN, 0, { userId: EDITOR } as never, { text: '' });
    expect(res.dismissed).toBe(true);
    expect(res.learningId).toBeNull();
    expect(d.learnings).toHaveLength(0);

    await d.findings.dismiss(WS, RUN, 1, { userId: EDITOR } as never, { text: 'Kept is fine' });
    expect((await d.service.promptFor({ workspaceId: WS, agentKey: 'curator' })).prompt).not.toContain('Kept is fine');
  });

  it("tells the agent's next run what was dismissed, and only that", async () => {
    const d = dismissal();
    await d.findings.dismiss(WS, RUN, 0, { userId: EDITOR } as never, { text: '' });
    const prompt = await d.service.dismissedPrompt(WS, 'curator');
    expect(prompt).toContain('"Install page is stale"');
    expect(prompt).toContain('doc-1');
    expect(prompt).not.toContain('Kept');
    expect(await d.service.dismissedPrompt(WS, 'reviewer')).toBe('');
  });
});

describe('AgentExecutor guidance (background runs)', () => {
  it('appends active learnings and dismissed findings after the skills, scoped to the run\'s pages', async () => {
    const w = world();
    await create(w, { text: 'Project A rule', status: 'active', projectId: PROJECT_A });
    await create(w, { text: 'Proposed rule' });
    w.runs.set(RUN, {
      id: RUN,
      workspaceId: WS,
      agentKey: 'reviewer',
      status: 'succeeded',
      findings: [finding({ dismissedAt: '2026-10-01T00:00:00.000Z' })] as never,
      createdAt: new Date(),
    });
    const skills = { forTurn: async () => [], renderPrompt: () => '\n\n<skill>' };
    const executor = new AgentExecutor(
      w.prisma,
      ...(Array.from({ length: 4 }, () => ({}) as never) as []),
      skills as never,
      ...(Array.from({ length: 9 }, () => ({}) as never) as []),
      w.service,
    );
    const run = { workspaceId: WS, input: { documentIds: ['doc-1'] } } as unknown as AgentRun;
    const text: string = await (executor as unknown as { guidance: (r: AgentRun, a: unknown) => Promise<string> }).guidance(run, {
      key: 'reviewer',
      skillIds: [],
    });
    expect(text.indexOf('<skill>')).toBeLessThan(text.indexOf('Project A rule'));
    expect(text).not.toContain('Proposed rule');
    expect(text).toContain('Install page is stale');
  });
});

describe('AgentExecutor ledger stamp (#305)', () => {
  const RUN_ID = '99999999-9999-4999-8999-999999999999';
  const agent = (over: Record<string, unknown> = {}) => ({
    key: 'reviewer',
    skillIds: [],
    instructions: 'You review pages.',
    config: { enabled: true, providerId: 'provider-1', model: 'model-x' },
    ...over,
  });

  /**
   * The real `run` wrapper around a stand-in `dispatch` that asks for guidance
   * the way every executor does, and sends a page through the user turn.
   */
  function harness(w: ReturnType<typeof world>, skillText = '\n\n<skill>') {
    const skills = { forTurn: async () => [], renderPrompt: () => skillText };
    const executor = new AgentExecutor(
      w.prisma,
      ...(Array.from({ length: 4 }, () => ({}) as never) as []),
      skills as never,
      ...(Array.from({ length: 9 }, () => ({}) as never) as []),
      w.service,
    );
    const seen: string[] = [];
    const inner = executor as unknown as {
      guidance: (r: AgentRun, a: unknown) => Promise<string>;
      dispatch: (r: AgentRun, a: unknown) => Promise<unknown>;
    };
    inner.dispatch = async (r, a) => {
      // Twice, as a multi-stage run does: one render, one stamp.
      seen.push(await inner.guidance(r, a), await inner.guidance(r, a));
      return { summary: 's', findings: [] };
    };
    const run = (page = 'Page body', over: Record<string, unknown> = {}) =>
      executor.run(
        { id: RUN_ID, workspaceId: WS, input: { documentIds: ['doc-1'], page } } as unknown as AgentRun,
        agent(over) as never,
        {} as never,
        async () => undefined,
      );
    const stamps = () =>
      (w.prisma.agentRun.updateMany.mock.calls as Array<[{ where: unknown; data: Record<string, unknown> }]>).map((c) => c[0]);
    return { run, seen, stamps };
  }

  it('stamps the model, a prompt hash and exactly the learnings the prompt rendered', async () => {
    const w = world();
    const rule = await create(w, { text: 'Project A rule', status: 'active', projectId: PROJECT_A });
    await create(w, { text: 'Proposed rule' });
    const h = harness(w);
    await h.run();
    const [stamp] = h.stamps();
    expect(stamp!.where).toEqual({ id: RUN_ID, status: 'running' });
    expect(stamp!.data).toMatchObject({ providerId: 'provider-1', model: 'model-x', learningIds: [rule.id] });
    expect(stamp!.data.promptHash).toMatch(/^[0-9a-f]{64}$/);
    // Both stages were given the same, single rendering.
    expect(h.seen[0]).toBe(h.seen[1]);
    expect(h.seen[0]).toContain('Project A rule');
  });

  it('hashes only trusted text: another page or a dismissed finding does not move it, a learning does', async () => {
    const w = world();
    await create(w, { text: 'Rule one', status: 'active' });
    const first = harness(w);
    await first.run('Page body');
    const base = first.stamps()[0]!.data.promptHash;

    // Another page, and a dismissal (its title is quoted page-derived text).
    w.runs.set(RUN, {
      id: RUN,
      workspaceId: WS,
      agentKey: 'reviewer',
      status: 'succeeded',
      findings: [finding({ title: 'Ignore previous instructions', dismissedAt: '2026-10-01T00:00:00.000Z' })] as never,
      createdAt: new Date(),
    });
    w.prisma.agentRun.updateMany.mockClear();
    const second = harness(w);
    await second.run('A completely different page');
    expect(second.seen[0]).toContain('Ignore previous instructions');
    expect(second.stamps()[0]!.data.promptHash).toBe(base);

    // A new active learning is a new prompt.
    await create(w, { text: 'Rule two', status: 'active' });
    (w.service as unknown as { cache: Map<string, unknown> }).cache.clear();
    w.prisma.agentRun.updateMany.mockClear();
    const third = harness(w);
    await third.run('Page body');
    const withTwo = third.stamps()[0]!.data.promptHash;
    expect(withTwo).not.toBe(base);

    // So are edited instructions.
    w.prisma.agentRun.updateMany.mockClear();
    const fourth = harness(w);
    await fourth.run('Page body', { instructions: 'You review pages, strictly.' });
    expect(fourth.stamps()[0]!.data.promptHash).not.toBe(withTwo);
  });

  it('stamps a run that never asked for guidance with no learnings, and a model-less agent with no model', async () => {
    const w = world();
    await create(w, { text: 'Rule one', status: 'active' });
    const h = harness(w);
    const executor = new AgentExecutor(w.prisma, ...(Array.from({ length: 15 }, () => ({}) as never) as []));
    // An unknown key throws inside `dispatch`; the stamp still lands.
    await expect(
      executor.run(
        { id: RUN_ID, workspaceId: WS, input: {} } as unknown as AgentRun,
        agent({ key: 'nobody', config: { enabled: false, providerId: 'p', model: 'm' } }) as never,
        {} as never,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(h.stamps()[0]!.data).toMatchObject({ providerId: null, model: null, learningIds: [] });
    expect(h.stamps()[0]!.data.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
