import { randomUUID } from 'node:crypto';
import { AGENT_OUTCOME_SETTLE_DAYS, AGENT_OUTCOMES, outcomeFor, type AgentOutcome } from '@knowledge/contracts';
import { AgentOutcomesService } from '../src/ai/agent-outcomes.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #305 phase 1: `outcomeFor` and its SQL twin `outcomeCaseSql` agree, row for
 * row, in real PostgreSQL — the jsonb unnesting, the merge-request join and
 * the settle cutoff are SQL a mocked Prisma cannot run. Needs the database
 * only (`make infra-up`); everything is written under throwaway ids and
 * deleted after.
 */
describe('agent outcomes (e2e, #305)', () => {
  const WS = randomUUID();
  const P = randomUUID();
  const OTHER_P = randomUUID();
  const DOC = randomUUID();
  const OTHER_DOC = randomUUID();
  const USER = randomUUID();
  const DAY = 86_400_000;
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const mr = { merged: randomUUID(), closed: randomUUID(), open: randomUUID() };

  let prisma: PrismaService;
  let svc: AgentOutcomesService;

  type Finding = { dismissedAt?: string; mergeRequestId?: string; documentIds: string[] };
  const runs: Array<{ id: string; agentKey: string; finishedAt: Date; model: string | null; promptHash: string | null; findings: Finding[] }> = [
    {
      id: randomUUID(),
      agentKey: 'reviewer',
      finishedAt: ago(AGENT_OUTCOME_SETTLE_DAYS + 2),
      model: 'model-a',
      promptHash: 'hash-1',
      findings: [
        { documentIds: [DOC] }, // standing past the window → accepted
        { documentIds: [DOC], dismissedAt: ago(1).toISOString() }, // dismissed
        { documentIds: [DOC], mergeRequestId: mr.merged }, // accepted
        { documentIds: [OTHER_DOC], mergeRequestId: mr.closed }, // dismissed
        { documentIds: [OTHER_DOC], mergeRequestId: mr.open }, // pending although old
        { documentIds: [DOC], mergeRequestId: 'not-a-uuid' }, // malformed id reads as no MR → accepted
      ],
    },
    {
      id: randomUUID(),
      agentKey: 'reviewer',
      finishedAt: ago(1),
      model: 'model-b',
      promptHash: 'hash-2',
      findings: [{ documentIds: [DOC] }], // fresh → pending
    },
    // A run that found nothing still counts towards n.
    { id: randomUUID(), agentKey: 'curator', finishedAt: ago(3), model: null, promptHash: null, findings: [] },
  ];
  const votes = [
    { rating: 'up', model: 'model-a', cited: [DOC] },
    { rating: 'down', model: 'model-a', cited: [OTHER_DOC] },
    { rating: 'down', model: null, cited: [] },
  ];

  /** What `outcomeFor` says, computed in TypeScript over the same rows. */
  function expected(filter: (f: Finding) => boolean = () => true) {
    const statusOf = new Map([[mr.merged, 'merged'], [mr.closed, 'closed'], [mr.open, 'open']]);
    const perAgent = new Map<string, Record<AgentOutcome, number>>();
    for (const run of runs) {
      const counts = perAgent.get(run.agentKey) ?? { accepted: 0, dismissed: 0, downvoted: 0, pending: 0 };
      for (const f of run.findings.filter(filter)) {
        counts[outcomeFor({ source: 'finding', dismissedAt: f.dismissedAt ?? null, mergeRequestStatus: statusOf.get(f.mergeRequestId ?? '') ?? null, finishedAt: run.finishedAt }, now)] += 1;
      }
      perAgent.set(run.agentKey, counts);
    }
    return perAgent;
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new AgentOutcomesService(prisma);

    await prisma.project.createMany({
      data: [
        { id: P, workspaceId: WS, name: 'e2e outcomes' },
        { id: OTHER_P, workspaceId: WS, name: 'e2e outcomes other' },
      ],
    });
    await prisma.document.createMany({
      data: [
        { id: DOC, workspaceId: WS, projectId: P, title: 'Outcome page' },
        { id: OTHER_DOC, workspaceId: WS, projectId: OTHER_P, title: 'Other page' },
      ],
    });
    const branch = randomUUID();
    await prisma.documentBranch.create({ data: { id: branch, documentId: DOC, name: 'main' } });
    for (const [status, id] of Object.entries(mr)) {
      await prisma.mergeRequest.create({
        data: { id, documentId: DOC, sourceBranchId: branch, targetBranchId: branch, title: status, status, authorId: USER, provenance: 'agent' },
      });
    }
    for (const run of runs) {
      await prisma.agentRun.create({
        data: {
          id: run.id,
          workspaceId: WS,
          agentKey: run.agentKey,
          status: 'succeeded',
          createdBy: USER,
          findings: run.findings.map((f) => ({ kind: 'other', severity: 'info', title: 't', detail: 'd', documentTitles: [], ...f })),
          createdAt: run.finishedAt,
          startedAt: run.finishedAt,
          finishedAt: run.finishedAt,
          model: run.model,
          promptHash: run.promptHash,
          learningIds: [],
        },
      });
    }
    // A failed run is not a finished one: it neither counts towards n nor has findings that count.
    await prisma.agentRun.create({
      data: { workspaceId: WS, agentKey: 'reviewer', status: 'failed', createdBy: USER, findings: [{ documentIds: [DOC] }] },
    });
    for (const v of votes) {
      await prisma.answerFeedback.create({
        data: { workspaceId: WS, kind: 'vote', surface: 'ask', rating: v.rating, query: 'q', createdBy: USER, model: v.model, citedDocumentIds: v.cited },
      });
    }
    // An implicit signal is not a vote.
    await prisma.answerFeedback.create({ data: { workspaceId: WS, kind: 'no-answer', surface: 'ask', query: 'q', createdBy: USER } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.answerFeedback.deleteMany({ where: { workspaceId: WS } });
    await prisma.agentRun.deleteMany({ where: { workspaceId: WS } });
    await prisma.mergeRequest.deleteMany({ where: { documentId: DOC } });
    await prisma.documentBranch.deleteMany({ where: { documentId: DOC } });
    await prisma.document.deleteMany({ where: { workspaceId: WS } });
    await prisma.project.deleteMany({ where: { workspaceId: WS } });
    await prisma.$disconnect();
  });

  it('counts each finding as outcomeFor classifies it, and every finished run towards n', async () => {
    const res = await svc.outcomes({ workspaceId: WS }, now);
    const want = expected();
    const findings = res.groups.filter((g) => g.source === 'finding');
    expect(findings.map((g) => g.agentKey).sort()).toEqual(['curator', 'reviewer']);
    for (const g of findings) expect(g.counts, g.agentKey!).toEqual(want.get(g.agentKey!));
    expect(findings.find((g) => g.agentKey === 'reviewer')!.runs).toBe(2);
    expect(findings.find((g) => g.agentKey === 'curator')!.runs).toBe(1);
    // The fixture exercises every finding outcome.
    const reviewer = findings.find((g) => g.agentKey === 'reviewer')!.counts;
    for (const o of AGENT_OUTCOMES.filter((x) => x !== 'downvoted')) expect(reviewer[o], o).toBeGreaterThan(0);
  });

  it('counts votes only, up as accepted and down as downvoted', async () => {
    const res = await svc.outcomes({ workspaceId: WS }, now);
    const answers = res.groups.filter((g) => g.source === 'answer');
    expect(answers).toEqual([
      expect.objectContaining({ agentKey: null, runs: 3, counts: { accepted: 1, dismissed: 0, downvoted: 2, pending: 0 } }),
    ]);
  });

  it('splits by prompt hash and by model', async () => {
    const byPrompt = await svc.outcomes({ workspaceId: WS, agentKey: 'reviewer', split: 'prompt' }, now);
    expect(byPrompt.groups.map((g) => [g.promptHash, g.runs]).sort()).toEqual([['hash-1', 1], ['hash-2', 1]]);
    // Naming an agent leaves the answers out: a vote carries no agent.
    expect(byPrompt.groups.every((g) => g.source === 'finding')).toBe(true);

    const byModel = await svc.outcomes({ workspaceId: WS, split: 'model' }, now);
    const answerModels = byModel.groups.filter((g) => g.source === 'answer').map((g) => [g.model, g.runs]);
    expect(answerModels.sort()).toEqual([['model-a', 2], [null, 1]].sort());
  });

  it('narrows to findings and answers citing a page of the project', async () => {
    const res = await svc.outcomes({ workspaceId: WS, projectId: P }, now);
    const want = expected((f) => f.documentIds.includes(DOC));
    const reviewer = res.groups.find((g) => g.source === 'finding' && g.agentKey === 'reviewer')!;
    expect(reviewer.counts).toEqual(want.get('reviewer'));
    // A run that cited nothing in the project is not one of its runs.
    expect(res.groups.find((g) => g.agentKey === 'curator')).toBeUndefined();
    expect(res.groups.find((g) => g.source === 'answer')!.runs).toBe(1);
  });

  it('applies the window', async () => {
    const res = await svc.outcomes({ workspaceId: WS, since: ago(2).toISOString() }, now);
    expect(res.groups.filter((g) => g.source === 'finding').map((g) => g.agentKey)).toEqual(['reviewer']);
  });
});
