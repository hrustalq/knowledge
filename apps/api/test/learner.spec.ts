import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { AgentLearning } from '@prisma/client';
import type { AgentFinding } from '@knowledge/contracts';
import {
  clusterFindings,
  coachInput,
  foldByEvidence,
  nearDuplicate,
  noDrop,
  qualifies,
  readCoachLearning,
  refKey,
  type DismissedFinding,
} from '../src/learner/learner-derive.js';
import { AUTHOR_ID_STUB, LearnerService } from '../src/learner/learner.service.js';
import { LearnerTicker } from '../src/learner/learner.ticker.js';
import { AgentLearningsService, choosePromptLearnings, evidenceRefsOf } from '../src/ai/agent-learnings.service.js';
import { BUILT_IN_CASES, measure, recommend } from '../src/learner/learner-calibration.js';

/**
 * The learner (#305, phase 2): the thresholds, folding, the prompt budget
 * split, back-pressure and the lifecycle check. The derivation and
 * before/after SQL run in Postgres in `learner.e2e-spec.ts`; here the service
 * runs over an in-memory prisma with hand-made vectors, so every decision is
 * asserted on what it writes.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';

let seq = 0;
function dismissed(over: Partial<DismissedFinding> = {}): DismissedFinding {
  seq += 1;
  return {
    runId: `run-${seq}`,
    findingIndex: 0,
    agentKey: 'reviewer',
    projectId: P,
    kind: 'stale',
    title: 'Legal page is stale',
    detail: 'not changed in a year',
    dismissedBy: ALICE,
    dismissedAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    locale: 'en',
    ...over,
  };
}

/** One axis per topic, so "similar" is exact: a text's vector is the axis of the first topic word in it. */
const TOPICS = ['stale', 'orphan', 'duplicate', 'legal rule', 'unrelated rule'];
function vectorFor(text: string): number[] {
  const at = TOPICS.findIndex((t) => text.includes(t));
  return TOPICS.map((_, i) => (i === (at < 0 ? TOPICS.length - 1 : at) ? 1 : 0));
}

function learnerWorld(opts: { findings: DismissedFinding[]; learnings?: Partial<AgentLearning>[]; coach?: string | null; agentEnabled?: boolean }) {
  const learnings = (opts.learnings ?? []).map((l, i) => ({
    id: `learning-${i + 1}`,
    workspaceId: WS,
    status: 'proposed',
    agentKey: 'reviewer',
    projectId: P,
    text: 't',
    evidence: null,
    ...l,
  })) as unknown as AgentLearning[];
  let created = 0;
  const prisma = {
    agentLearning: {
      findMany: vi.fn(async () => [...learnings]),
      create: vi.fn(async ({ data }: { data: Partial<AgentLearning> }) => {
        const row = { id: `derived-${++created}`, ...data } as AgentLearning;
        learnings.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    // The fold: `UPDATE agent_learnings SET evidence = … WHERE id = $id`.
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const row = learnings.find((l) => l.id === values[1]);
      if (!row || !['proposed', 'active'].includes(row.status)) return 0;
      const refs = JSON.parse(values[0] as string) as unknown[];
      const have = Array.isArray(row.evidence) ? (row.evidence as unknown[]) : [];
      const keys = new Set(have.map((e) => JSON.stringify(e)));
      row.evidence = [...have, ...refs.filter((r) => !keys.has(JSON.stringify(r)))] as never;
      return 1;
    }),
  };
  const embedding = { dimension: TOPICS.length, embed: vi.fn(), embedBatch: vi.fn(async (texts: string[]) => texts.map(vectorFor)) };
  const agents = {
    resolve: vi.fn(async () => ({ enabled: opts.agentEnabled ?? true, instructions: 'coach', config: { enabled: true, workspaceId: WS } })),
  };
  const client = { chat: vi.fn(async () => JSON.stringify({ learning: opts.coach === undefined ? 'Do not flag legal rule pages as stale.' : opts.coach })) };
  const aiUsage = { assertWithinBudget: vi.fn(async () => undefined) };
  const outcomes = { beforeAfter: vi.fn() };
  const config = {
    get: (k: string) =>
      ({ LEARNER_CLUSTER_THRESHOLD: 0.7, LEARNER_MIN_DISMISSALS: 3, LEARNER_MIN_PEOPLE: 2, LEARNER_WINDOW_DAYS: 30, LEARNER_MIN_RUNS: 20, I18N_DEFAULT_LOCALE: 'en' })[k],
  };
  const learner = new LearnerService(prisma as never, embedding as never, agents as never, client as never, aiUsage as never, outcomes as never, config as never);
  vi.spyOn(learner, 'dismissedFindings').mockResolvedValue(opts.findings.filter((f) => f.agentKey !== 'mcp'));
  vi.spyOn(learner, 'mcpFailures').mockResolvedValue(opts.findings.filter((f) => f.agentKey === 'mcp'));
  return { learner, prisma, client, learnings, outcomes };
}

describe('learner thresholds', () => {
  it('three dismissals from one person do not qualify; from two people they do', () => {
    const fromOne = [dismissed(), dismissed(), dismissed()];
    expect(qualifies(fromOne, { minDismissals: 3, minPeople: 2 })).toBe(false);
    expect(qualifies([...fromOne.slice(0, 2), dismissed({ dismissedBy: BOB })], { minDismissals: 3, minPeople: 2 })).toBe(true);
    expect(qualifies([dismissed(), dismissed({ dismissedBy: BOB })], { minDismissals: 3, minPeople: 2 })).toBe(false);
  });

  it('clusters by raw cosine at the threshold, never across topics', () => {
    const a = [dismissed(), dismissed(), dismissed({ kind: 'orphan', title: 'orphan page' })];
    const vectors = new Map(a.map((f) => [refKey(f), vectorFor(`${f.kind}: ${f.title}`)]));
    const clusters = clusterFindings(a, vectors, 0.7);
    expect(clusters.map((c) => c.length).sort()).toEqual([1, 2]);
  });

  it('wraps the findings untrusted for the coach and reads only a string learning back', () => {
    const input = coachInput('reviewer', [dismissed(), dismissed({ dismissedBy: BOB })]);
    expect(input).toContain('<findings tool="coach">');
    expect(input).toContain('dismissed by 2 different people');
    expect(readCoachLearning('{"learning": "  Check the history first. "}')).toBe('Check the history first.');
    expect(readCoachLearning('```json\n{"learning": "Rule."}\n```')).toBe('Rule.');
    expect(readCoachLearning('{"learning": null}')).toBeNull();
    expect(readCoachLearning('{"learning": ""}')).toBeNull();
    expect(readCoachLearning('not json')).toBeNull();
    expect(readCoachLearning(JSON.stringify({ learning: 'x'.repeat(1_001) }))).toBeNull();
  });
});

describe('LearnerService.derive', () => {
  it('turns three similar dismissals from two people into exactly one proposed, derived learning with evidence', async () => {
    const findings = [dismissed(), dismissed({ dismissedBy: BOB }), dismissed(), dismissed({ kind: 'orphan', title: 'orphan page' })];
    const w = learnerWorld({ findings });
    const result = await w.learner.derive(WS);

    expect(result).toEqual({ proposed: 1, folded: 0, declined: 0 });
    expect(w.client.chat).toHaveBeenCalledTimes(1);
    expect(w.client.chat.mock.calls[0]![0]).toMatchObject({ operation: 'coach', userId: AUTHOR_ID_STUB });
    const data = w.prisma.agentLearning.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: WS,
      agentKey: 'reviewer',
      projectId: P,
      status: 'proposed',
      sourceKind: 'derived',
      createdBy: AUTHOR_ID_STUB,
      text: 'Do not flag legal rule pages as stale.',
    });
    expect((data.evidence as unknown[]).map((r) => refKey(r as never)).sort()).toEqual(findings.slice(0, 3).map(refKey).sort());
  });

  it('writes nothing for three dismissals from one person, and never asks the coach', async () => {
    const w = learnerWorld({ findings: [dismissed(), dismissed(), dismissed()] });
    expect(await w.learner.derive(WS)).toEqual({ proposed: 0, folded: 0, declined: 0 });
    expect(w.client.chat).not.toHaveBeenCalled();
    expect(w.prisma.agentLearning.create).not.toHaveBeenCalled();
  });

  it('folds a fourth similar dismissal into the row the first three made, never inserting a second', async () => {
    const first = [dismissed(), dismissed({ dismissedBy: BOB }), dismissed()];
    const w = learnerWorld({ findings: first });
    await w.learner.derive(WS);
    expect(w.learnings).toHaveLength(1);

    const fourth = dismissed({ dismissedBy: BOB });
    vi.spyOn(w.learner, 'dismissedFindings').mockResolvedValue([...first, fourth]);
    const result = await w.learner.derive(WS);

    expect(result).toEqual({ proposed: 0, folded: 1, declined: 0 });
    expect(w.prisma.agentLearning.create).toHaveBeenCalledTimes(1);
    expect(w.client.chat).toHaveBeenCalledTimes(1);
    expect((w.learnings[0]!.evidence as unknown[]).map((r) => refKey(r as never))).toContain(refKey(fourth));
    expect(w.learnings[0]!.evidence as unknown[]).toHaveLength(4);

    // A third pass with nothing new writes nothing.
    w.prisma.$executeRaw.mockClear();
    expect(await w.learner.derive(WS)).toEqual({ proposed: 0, folded: 0, declined: 0 });
    expect(w.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('writes nothing for a cluster an admin already archived', async () => {
    const findings = [dismissed(), dismissed({ dismissedBy: BOB }), dismissed(), dismissed({ dismissedBy: BOB })];
    const w = learnerWorld({
      findings,
      learnings: [{ status: 'archived', sourceKind: 'derived', evidence: [{ runId: findings[0]!.runId, findingIndex: 0 }] as never }],
    });
    expect(await w.learner.derive(WS)).toEqual({ proposed: 0, folded: 0, declined: 0 });
    expect(w.client.chat).not.toHaveBeenCalled();
    expect(w.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('folds a draft into a near-identical existing learning for the same agent and project', async () => {
    const findings = [dismissed(), dismissed({ dismissedBy: BOB }), dismissed()];
    const w = learnerWorld({
      findings,
      // A person already wrote it; the coach's draft says the same thing.
      learnings: [{ status: 'active', sourceKind: 'manual', text: 'Never call legal rule pages stale.' }],
    });
    expect(await w.learner.derive(WS)).toEqual({ proposed: 0, folded: 1, declined: 0 });
    expect(w.prisma.agentLearning.create).not.toHaveBeenCalled();
    expect(w.learnings[0]!.evidence as unknown[]).toHaveLength(3);
  });

  it('a different text, or another project, is not a near-duplicate', () => {
    expect(nearDuplicate([1, 0], [{ id: 'a', vector: [0, 1] }], 0.7)).toBeNull();
    expect(nearDuplicate([1, 0], [{ id: 'a', vector: [0.6, 0.8] }, { id: 'b', vector: [1, 0.1] }], 0.7)).toBe('b');
    const cluster = [dismissed()];
    expect(foldByEvidence(cluster, [{ id: 'x', status: 'active', agentKey: 'reviewer', projectId: 'other', evidence: [cluster[0]!] }])).toEqual({ kind: 'new' });
  });

  it('counts a declined cluster and writes nothing when the coach answers null or is switched off', async () => {
    const findings = [dismissed(), dismissed({ dismissedBy: BOB }), dismissed()];
    const declined = learnerWorld({ findings, coach: null });
    expect(await declined.learner.derive(WS)).toEqual({ proposed: 0, folded: 0, declined: 1 });
    const off = learnerWorld({ findings, agentEnabled: false });
    expect(await off.learner.derive(WS)).toEqual({ proposed: 0, folded: 0, declined: 1 });
    expect(off.client.chat).not.toHaveBeenCalled();
    expect(off.prisma.agentLearning.create).not.toHaveBeenCalled();
  });
});

describe('LearnerService.derive — the mcp target (#305, phase 3)', () => {
  /** An MCP failure: a turned-down capture, or a downvoted answer. */
  const failure = (ref: { captureId: string } | { feedbackId: string }, over: Partial<DismissedFinding> = {}) => {
    const { runId: _r, findingIndex: _i, ...rest } = dismissed({ agentKey: 'mcp', kind: 'gotcha', title: 'stale capture of the legal rule', ...over }) as DismissedFinding & {
      runId: string;
      findingIndex: number;
    };
    return { ...ref, ...rest } as DismissedFinding;
  };

  it('clusters rejected captures and downvoted answers into one proposed mcp learning, with their refs as evidence', async () => {
    const failures = [failure({ captureId: 'c1' }), failure({ captureId: 'c2' }, { dismissedBy: BOB }), failure({ feedbackId: 'f1' })];
    const w = learnerWorld({ findings: failures });
    expect(await w.learner.derive(WS)).toEqual({ proposed: 1, folded: 0, declined: 0 });
    expect(w.client.chat.mock.calls[0]![1]![1]!.content).toContain('external agents connected over MCP');
    const data = w.prisma.agentLearning.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ agentKey: 'mcp', projectId: P, sourceKind: 'derived', status: 'proposed' });
    expect(data.evidence).toEqual(expect.arrayContaining([{ captureId: 'c1' }, { captureId: 'c2' }, { feedbackId: 'f1' }]));
    expect(data.evidence).toHaveLength(3);
  });

  it('never mixes the mcp target with an agent that made the same mistake', async () => {
    const w = learnerWorld({
      findings: [failure({ captureId: 'c1' }), failure({ captureId: 'c2' }, { dismissedBy: BOB }), dismissed({ title: 'legal rule' }), dismissed({ title: 'legal rule', dismissedBy: BOB })],
    });
    expect(await w.learner.derive(WS)).toEqual({ proposed: 0, folded: 0, declined: 0 });
  });
});

describe('evidence refs', () => {
  it('reads all three kinds back and drops anything malformed', () => {
    expect(
      evidenceRefsOf([{ runId: 'r', findingIndex: 2 }, { captureId: 'c' }, { feedbackId: 'f' }, { runId: 'r' }, { captureId: 3 }, null, 'x']),
    ).toEqual([{ runId: 'r', findingIndex: 2 }, { captureId: 'c' }, { feedbackId: 'f' }]);
    expect(new Set([refKey({ runId: 'a', findingIndex: 0 }), refKey({ captureId: 'a' }), refKey({ feedbackId: 'a' })]).size).toBe(3);
  });
});

describe('LearnerService.checkLifecycle', () => {
  const side = (runs: number, findings: number, dismissedN: number) => ({ runs, findings, dismissed: dismissedN });
  const active = (over: Record<string, unknown> = {}) => ({ id: 'l1', status: 'active', agentKey: 'reviewer', approvedAt: new Date(), archiveCheck: null, ...over });

  it('flags an active learning with 20+ runs on each side and no drop in dismissals — and archives nothing', async () => {
    const w = learnerWorld({ findings: [], learnings: [active()] as never });
    w.outcomes.beforeAfter.mockResolvedValue({ before: side(20, 40, 10), after: side(20, 40, 12) });
    expect(await w.learner.checkLifecycle(WS)).toBe(1);
    const call = (w.prisma.agentLearning.updateMany.mock.calls[0] as unknown as [{ where: unknown; data: Record<string, unknown> }])[0];
    expect(call.where).toEqual({ id: 'l1', status: 'active', archiveProposedAt: null });
    expect(call.data.archiveProposedAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty('status');
    expect(call.data.archiveCheck).toMatchObject({ before: side(20, 40, 10), after: side(20, 40, 12) });
  });

  it('says nothing below 20 runs on either side, when dismissals dropped, or once an admin kept it', async () => {
    const few = learnerWorld({ findings: [], learnings: [active()] as never });
    few.outcomes.beforeAfter.mockResolvedValue({ before: side(19, 40, 10), after: side(30, 40, 20) });
    expect(await few.learner.checkLifecycle(WS)).toBe(0);

    const helped = learnerWorld({ findings: [], learnings: [active()] as never });
    helped.outcomes.beforeAfter.mockResolvedValue({ before: side(20, 40, 10), after: side(20, 40, 4) });
    expect(await helped.learner.checkLifecycle(WS)).toBe(0);

    const kept = learnerWorld({ findings: [], learnings: [active({ archiveCheck: { keptAt: '2026-10-01T00:00:00Z' } })] as never });
    expect(await kept.learner.checkLifecycle(WS)).toBe(0);
    expect(kept.outcomes.beforeAfter).not.toHaveBeenCalled();
  });

  it('noDrop compares rates, not counts', () => {
    expect(noDrop({ before: side(20, 100, 10), after: side(20, 10, 2) }, 20)).toBe(true); // 10 % → 20 %
    expect(noDrop({ before: side(20, 10, 2), after: side(20, 100, 10) }, 20)).toBe(false); // 20 % → 10 %
    expect(noDrop({ before: side(20, 0, 0), after: side(20, 0, 0) }, 20)).toBe(true);
    expect(noDrop({ before: side(20, 10, 2), after: side(19, 10, 2) }, 20)).toBeNull();
  });
});

describe('prompt budget split', () => {
  let n = 0;
  const row = (sourceKind: string, text = 'rule'): AgentLearning =>
    ({ id: `l-${++n}`, workspaceId: WS, agentKey: null, projectId: null, sourceKind, text, status: 'active' }) as AgentLearning;
  const audience = { workspaceId: WS, agentKey: 'reviewer' };

  it('never lets a derived learning displace a hand-written one', () => {
    // Newest first: three derived learnings newer than every manual one.
    const rows = [row('derived'), row('derived'), row('derived'), row('manual'), row('finding'), row('manual'), row('mr-thread')];
    const chosen = choosePromptLearnings(rows, audience, 4);
    expect(chosen.map((l) => l.sourceKind)).toEqual(['manual', 'finding', 'manual', 'mr-thread']);
  });

  it('gives derived learnings at most half the count and half the characters, in prompt order', () => {
    const rows = [row('derived'), row('manual'), row('derived'), row('derived'), row('manual'), row('derived')];
    const chosen = choosePromptLearnings(rows, audience, 6);
    expect(chosen.filter((l) => l.sourceKind === 'derived')).toHaveLength(3);
    expect(chosen.map((l) => l.id)).toEqual(rows.filter((r) => chosen.includes(r)).map((r) => r.id));

    const long = [row('derived', 'x'.repeat(1_500)), row('derived', 'y'.repeat(1_500)), row('manual', 'z'.repeat(100))];
    const byChars = choosePromptLearnings(long, audience, 20, 4_000);
    expect(byChars.map((l) => l.text.length)).toEqual([1_500, 100]);
  });

  it('gives the mcp target only learnings naming it, never every-agent ones (#305)', () => {
    const mcp = { ...row('manual', 'mcp rule'), agentKey: 'mcp' } as AgentLearning;
    const rows = [row('manual', 'every agent'), mcp];
    expect(choosePromptLearnings(rows, { workspaceId: WS, agentKey: 'mcp', everyAgent: false }, 20)).toEqual([mcp]);
    expect(choosePromptLearnings(rows, audience, 20).map((l) => l.text)).toEqual(['every agent']);
  });

  it('is exactly the old choice when nothing is derived', () => {
    const rows = [row('manual', 'a'.repeat(3_000)), row('manual', 'b'.repeat(2_000)), row('manual', 'c'.repeat(900))];
    expect(choosePromptLearnings(rows, audience, 20, 4_000).map((l) => l.text[0])).toEqual(['a', 'c']);
    expect(choosePromptLearnings(rows, audience, 1, 4_000).map((l) => l.text[0])).toEqual(['a']);
  });
});

describe('LearnerTicker back-pressure', () => {
  function ticker(enabled = true) {
    let release: () => void = () => undefined;
    const learner = {
      workspaceIds: vi.fn(async () => [WS]),
      pass: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    };
    const config = { get: (k: string) => ({ LEARNER_ENABLED: enabled, LEARNER_TICK_MS: 60_000 })[k] };
    return { t: new LearnerTicker(learner as never, config as never), learner, release: () => release() };
  }

  it('starts no second pass while one is in flight', async () => {
    const { t, learner, release } = ticker();
    const first = t.tick();
    await vi.waitFor(() => expect(learner.pass).toHaveBeenCalledTimes(1));
    expect(await t.tick()).toBe('busy');
    expect(await t.tick()).toBe('busy');
    release();
    expect(await first).toEqual({ passed: 1 });
    expect(learner.pass).toHaveBeenCalledTimes(1);
  });

  it('passes over a workspace once a day, and not at all when disabled', async () => {
    const { t, learner, release } = ticker();
    let clock = Date.UTC(2026, 9, 20);
    const first = t.tick(() => clock);
    await vi.waitFor(() => expect(learner.pass).toHaveBeenCalledTimes(1));
    release();
    await first;
    clock += 3_600_000;
    expect(await t.tick(() => clock)).toEqual({ passed: 0 });
    clock += 86_400_000;
    const next = t.tick(() => clock);
    await vi.waitFor(() => expect(learner.pass).toHaveBeenCalledTimes(2));
    release();
    expect(await next).toEqual({ passed: 1 });

    const off = ticker(false);
    expect(await off.t.tick()).toBe('disabled');
    expect(off.learner.workspaceIds).not.toHaveBeenCalled();
  });
});

describe('learnings API surface', () => {
  function service(rows: Partial<AgentLearning>[], runs: Array<{ id: string; agentKey: string; findings: AgentFinding[] }>) {
    const prisma = {
      agentLearning: {
        findMany: vi.fn(async ({ select }: { select?: unknown }) => (select ? rows.map((r) => ({ id: r.id, evidence: r.evidence })) : rows)),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AgentLearning> }) => ({ ...rows.find((r) => r.id === where.id), ...data })),
      },
      agentRun: { findMany: vi.fn(async () => runs) },
    };
    const config = { get: () => 20 };
    return { svc: new AgentLearningsService(prisma as never, config as never), prisma };
  }
  const base = { workspaceId: WS, agentKey: 'reviewer', projectId: null, text: 't', createdBy: AUTHOR_ID_STUB, createdAt: new Date(), updatedAt: new Date() };
  const f = (title: string, documentIds: string[]): AgentFinding =>
    ({ kind: 'stale', severity: 'info', title, detail: 'd', documentIds, documentTitles: [], dismissedAt: '2026-10-01T00:00:00Z' }) as AgentFinding;

  it('titles evidence only where the viewer may open every cited page, and counts the rest', async () => {
    const { svc } = service(
      [{ ...base, id: 'l1', status: 'proposed', sourceKind: 'derived', evidence: [{ runId: 'r1', findingIndex: 0 }, { runId: 'r1', findingIndex: 1 }, { runId: 'gone', findingIndex: 0 }] as never }],
      [{ id: 'r1', agentKey: 'reviewer', findings: [f('Open page is stale', ['open']), f('Secret page is stale', ['open', 'secret'])] }],
    );
    const [learning] = await svc.listForViewer(WS, {}, async (ids) => new Set(ids.filter((id) => id !== 'secret')));
    expect(learning!.evidenceCount).toBe(3);
    expect(learning!.evidence!.findings.map((x) => x.title)).toEqual(['Open page is stale']);
    expect(learning!.evidence!.hidden).toBe(2);
    expect(JSON.stringify(learning)).not.toContain('Secret page');
  });

  it('resolves capture and vote evidence by the same rule, and a denied project hides a capture (#305)', async () => {
    const { svc, prisma } = service(
      [{ ...base, id: 'l1', agentKey: 'mcp', status: 'proposed', sourceKind: 'derived', evidence: [{ captureId: 'c-open' }, { captureId: 'c-denied' }, { feedbackId: 'f-open' }, { feedbackId: 'f-secret' }] as never }],
      [],
    );
    const at = new Date('2026-10-02T00:00:00Z');
    Object.assign(prisma, {
      knowledgeCapture: {
        findMany: vi.fn(async () => [
          { id: 'c-open', projectId: 'p-open', kind: 'gotcha', title: 'Open capture', targetDocumentId: 'open', mergeRequestId: 'mr1', updatedAt: at },
          { id: 'c-denied', projectId: 'p-secret', kind: 'gotcha', title: 'Secret capture', targetDocumentId: null, mergeRequestId: null, updatedAt: at },
        ]),
      },
      answerFeedback: {
        findMany: vi.fn(async () => [
          { id: 'f-open', reason: 'wrong', query: 'Open question', citedDocumentIds: ['open'], createdAt: at },
          { id: 'f-secret', reason: 'wrong', query: 'Secret question', citedDocumentIds: ['secret'], createdAt: at },
        ]),
      },
      mergeRequest: { findMany: vi.fn(async () => [{ id: 'mr1', documentId: 'open', closedAt: at }]) },
    });
    const [learning] = await svc.listForViewer(WS, {}, async (ids) => new Set(ids.filter((id) => id !== 'secret')), new Set(['p-secret']));
    expect(learning!.evidence!.findings.map((x) => [x.title, x.agentKey])).toEqual([
      ['Open capture', 'mcp'],
      ['Open question', 'mcp'],
    ]);
    expect(learning!.evidence!.hidden).toBe(2);
    expect(JSON.stringify(learning)).not.toMatch(/Secret/);
  });

  it('refuses a learning claiming to be derived from anyone but the learner', async () => {
    const { svc } = service([], []);
    await expect(svc.create({ workspaceId: WS, text: 'x', sourceKind: 'derived' }, ALICE, {} as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keep clears the proposed-archive flag and records who kept it; a new approval resets it', async () => {
    const flagged = { ...base, id: 'l1', status: 'active', sourceKind: 'manual', archiveProposedAt: new Date(), archiveCheck: { before: {}, after: {}, checkedAt: 'x' } as never };
    const { svc, prisma } = service([flagged], []);
    await svc.update('l1', { keepActive: true }, ALICE);
    const data = prisma.agentLearning.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.archiveProposedAt).toBeNull();
    expect(data.archiveCheck).toMatchObject({ checkedAt: 'x', keptBy: ALICE });
    expect(data).not.toHaveProperty('status');

    const archived = { ...flagged, id: 'l2', status: 'archived' };
    const again = service([archived], []);
    await again.svc.update('l2', { status: 'active' }, ALICE);
    const reapproved = again.prisma.agentLearning.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(reapproved).toMatchObject({ status: 'active', approvedBy: ALICE, archiveProposedAt: null });
  });
});

describe('learner calibration', () => {
  it('reports a mixed cluster when the threshold is too loose and recommends none then', () => {
    const cases = BUILT_IN_CASES.slice(0, 8); // two mistakes, four findings each
    const one = cases.map(() => [1, 0]);
    const loose = measure(cases, one, 0.5);
    expect(loose.mixed).toBe(1);
    expect(recommend([loose])).toBeNull();
    const apart = cases.map((c) => (c.label === cases[0]!.label ? [1, 0] : [0, 1]));
    const row = measure(cases, apart, 0.5);
    expect(row).toMatchObject({ mixed: 0, absorbed: 0, recovered: 2, groups: 2, pairPrecision: 1, pairRecall: 1 });
    expect(recommend([row])).toBe(0.5);
  });
});
