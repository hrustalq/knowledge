import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { AgentOutcomesService } from '../src/ai/agent-outcomes.service.js';
import { LearnerService } from '../src/learner/learner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #305 phase 2: the learner's two queries in real PostgreSQL — the jsonb
 * unnesting with ordinality, the "every cited page open to the workspace"
 * filter built from `visibilitySql`, and the before/after split on
 * `learning_ids`. A mocked Prisma cannot run any of them. Needs the database
 * only (`make infra-up`); everything is written under throwaway ids and
 * deleted after.
 */
describe('learner (e2e, #305)', () => {
  const WS = randomUUID();
  const P = randomUUID();
  const OPEN = randomUUID();
  const OPEN_2 = randomUUID();
  const RESTRICTED = randomUUID();
  const UNDER_RESTRICTED = randomUUID();
  const PENDING = randomUUID();
  const ALICE = randomUUID();
  const BOB = randomUUID();
  const DAY = 86_400_000;
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const LEARNING = randomUUID();
  const approvedAt = ago(10);

  let prisma: PrismaService;
  let learner: LearnerService;
  let outcomes: AgentOutcomesService;

  const finding = (documentIds: string[], over: Record<string, unknown> = {}) => ({
    kind: 'stale',
    severity: 'info',
    title: 'Page is stale',
    detail: 'd',
    documentIds,
    documentTitles: [],
    ...over,
  });
  const dismissed = (by: string, days = 1) => ({ dismissedAt: ago(days).toISOString(), dismissedBy: by });

  const derivationRun = randomUUID();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    outcomes = new AgentOutcomesService(prisma);
    const config = {
      get: (key: string) =>
        ({
          LEARNER_CLUSTER_THRESHOLD: 0.7,
          LEARNER_MIN_DISMISSALS: 3,
          LEARNER_MIN_PEOPLE: 2,
          LEARNER_WINDOW_DAYS: 30,
          LEARNER_MIN_RUNS: 20,
          I18N_DEFAULT_LOCALE: 'en',
        })[key],
    };
    learner = new LearnerService(prisma, {} as never, {} as never, {} as never, {} as never, outcomes, config as never);

    await prisma.project.create({ data: { id: P, workspaceId: WS, name: 'e2e learner' } });
    await prisma.document.createMany({
      data: [
        { id: OPEN, workspaceId: WS, projectId: P, title: 'Open page', path: `/${OPEN}/` },
        { id: OPEN_2, workspaceId: WS, projectId: P, title: 'Open page 2', path: `/${OPEN_2}/` },
        // A restricted page and a page under it: both carry the restricted node.
        { id: RESTRICTED, workspaceId: WS, projectId: P, title: 'Restricted', path: `/${RESTRICTED}/`, restricted: true, restrictedBy: [RESTRICTED] },
        { id: UNDER_RESTRICTED, workspaceId: WS, projectId: P, title: 'Child', parentId: RESTRICTED, path: `/${RESTRICTED}/${UNDER_RESTRICTED}/`, restrictedBy: [RESTRICTED] },
        // A head-less page behind a merge request is not listed.
        { id: PENDING, workspaceId: WS, projectId: P, title: 'Pending', path: `/${PENDING}/`, pendingMergeRequestId: randomUUID() },
      ],
    });
    await prisma.agentRun.create({
      data: {
        id: derivationRun,
        workspaceId: WS,
        agentKey: 'reviewer',
        status: 'succeeded',
        createdBy: ALICE,
        locale: 'ru',
        findings: [
          finding([OPEN], dismissed(ALICE)), // 0: qualifies
          finding([OPEN_2], dismissed(BOB)), // 1: qualifies
          finding([OPEN, RESTRICTED], dismissed(BOB)), // 2: cites a restricted page → excluded
          finding([UNDER_RESTRICTED], dismissed(ALICE)), // 3: under a restricted page → excluded
          finding([OPEN], dismissed(ALICE, 45)), // 4: outside the window
          finding([OPEN]), // 5: never dismissed
          finding([], dismissed(ALICE)), // 6: cites nothing
          finding([PENDING], dismissed(BOB)), // 7: a page no list shows
          finding([randomUUID()], dismissed(BOB)), // 8: a page that does not exist
          finding([OPEN], { dismissedAt: ago(1).toISOString() }), // 9: no dismisser recorded
        ],
      },
    });
    // A failed run's findings are never read.
    await prisma.agentRun.create({
      data: { workspaceId: WS, agentKey: 'reviewer', status: 'failed', createdBy: ALICE, findings: [finding([OPEN], dismissed(BOB))] },
    });

    // Before/after: 3 runs before the approval (one with a dismissed finding),
    // 2 after carrying the learning, 1 after without it, 1 unattributed.
    const run = (createdAt: Date, learningIds: string[] | null, findings: unknown[]) =>
      prisma.agentRun.create({
        data: {
          workspaceId: WS,
          agentKey: 'curator',
          status: 'succeeded',
          createdBy: ALICE,
          createdAt,
          finishedAt: createdAt,
          ...(learningIds ? { learningIds } : {}),
          findings: findings as never,
        },
      });
    await run(ago(20), [], [finding([OPEN], dismissed(ALICE, 19)), finding([OPEN])]);
    await run(ago(19), [], [finding([OPEN])]);
    await run(ago(18), [], []);
    await run(ago(5), [LEARNING], [finding([OPEN], dismissed(BOB, 4))]);
    await run(ago(4), [LEARNING, randomUUID()], [finding([OPEN])]);
    await run(ago(3), [], [finding([OPEN], dismissed(BOB, 2))]);
    // Created before the ledger: learning_ids NULL, on neither side.
    await run(ago(25), null, [finding([OPEN], dismissed(BOB, 24))]);
    // Another agent's run is not this learning's.
    await prisma.agentRun.create({
      data: { workspaceId: WS, agentKey: 'reviewer', status: 'succeeded', createdBy: ALICE, createdAt: ago(20), learningIds: [], findings: [] },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.agentLearning.deleteMany({ where: { workspaceId: WS } });
    await prisma.agentRun.deleteMany({ where: { workspaceId: WS } });
    await prisma.document.deleteMany({ where: { workspaceId: WS } });
    await prisma.project.deleteMany({ where: { workspaceId: WS } });
    await prisma.$disconnect();
  });

  it('reads only dismissed findings in the window whose every cited page the whole workspace can open', async () => {
    const rows = await learner.dismissedFindings(WS, now);
    const fromRun = rows.filter((r) => r.runId === derivationRun);
    expect(fromRun.map((r) => r.findingIndex).sort()).toEqual([0, 1]);
    expect(fromRun.map((r) => r.dismissedBy).sort()).toEqual([ALICE, BOB].sort());
    expect(fromRun.every((r) => r.projectId === P && r.agentKey === 'reviewer' && r.locale === 'ru')).toBe(true);
    // No row anywhere cites the restricted page or its child.
    const indexes = new Set(rows.filter((r) => r.runId === derivationRun).map((r) => r.findingIndex));
    expect(indexes.has(2)).toBe(false);
    expect(indexes.has(3)).toBe(false);
  });

  it('counts runs and dismissals on each side of an activation by learning_ids', async () => {
    const counts = await outcomes.beforeAfter(WS, { id: LEARNING, agentKey: 'curator', approvedAt }, now);
    // Before: the three attributed curator runs created before the approval.
    expect(counts.before).toEqual({ runs: 3, findings: 3, dismissed: 1 });
    // After: only the runs whose prompt carried it — not the later run without it.
    expect(counts.after).toEqual({ runs: 2, findings: 2, dismissed: 1 });
  });

  it('writes one proposed derived learning per qualifying cluster, then folds a later dismissal into it', async () => {
    const chat = vi.fn(async () => JSON.stringify({ learning: 'Do not report pages as stale only for their age.' }));
    const config = {
      get: (key: string) =>
        ({ LEARNER_CLUSTER_THRESHOLD: 0.7, LEARNER_MIN_DISMISSALS: 3, LEARNER_MIN_PEOPLE: 2, LEARNER_WINDOW_DAYS: 30, LEARNER_MIN_RUNS: 20, I18N_DEFAULT_LOCALE: 'en' })[key],
    };
    const deriving = new LearnerService(
      prisma,
      { dimension: 2, embed: vi.fn(), embedBatch: async (texts: string[]) => texts.map(() => [1, 0]) } as never,
      { resolve: async () => ({ enabled: true, instructions: 'coach', config: { enabled: true, workspaceId: WS } }) } as never,
      { chat } as never,
      { assertWithinBudget: async () => undefined } as never,
      outcomes,
      config as never,
    );
    // The curator's four dismissals in the window (two people) qualify; the
    // reviewer's two readable ones do not.
    expect(await deriving.derive(WS, now)).toEqual({ proposed: 1, folded: 0, declined: 0 });
    const [row] = await prisma.agentLearning.findMany({ where: { workspaceId: WS } });
    expect(row).toMatchObject({ status: 'proposed', sourceKind: 'derived', agentKey: 'curator', projectId: P, createdBy: '00000000-0000-0000-0000-000000000000' });
    expect(row!.evidence as unknown[]).toHaveLength(4);

    // Nothing new: nothing written, the coach not asked again.
    expect(await deriving.derive(WS, now)).toEqual({ proposed: 0, folded: 0, declined: 0 });
    expect(chat).toHaveBeenCalledTimes(1);

    await prisma.agentRun.create({
      data: { workspaceId: WS, agentKey: 'curator', status: 'succeeded', createdBy: ALICE, findings: [finding([OPEN_2], dismissed(ALICE))] as never },
    });
    expect(await deriving.derive(WS, now)).toEqual({ proposed: 0, folded: 1, declined: 0 });
    const rows = await prisma.agentLearning.findMany({ where: { workspaceId: WS } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidence as unknown[]).toHaveLength(5);
  });

  it('counts every agent for a learning given to every agent', async () => {
    const counts = await outcomes.beforeAfter(WS, { id: LEARNING, agentKey: null, approvedAt }, now);
    // The reviewer's attributed run before the approval joins the before side.
    expect(counts.before.runs).toBe(4);
    expect(counts.after.runs).toBe(2);
  });
});

/**
 * #305 phase 3: the `mcp` target's failures in real PostgreSQL — the activity
 * row that names who turned a capture down, the closed-unmerged merge request,
 * the downvote by traceId, and the same "every named page open to the
 * workspace" rule as findings. A duplicate capture is not a failure.
 */
describe('learner mcp failures (e2e, #305)', () => {
  const WS = randomUUID();
  const P = randomUUID();
  const SECRET_P = randomUUID();
  const OPEN = randomUUID();
  const RESTRICTED = randomUUID();
  const ALICE = randomUUID();
  const BOB = randomUUID();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const id = {
    rejected: randomUUID(),
    closed: randomUUID(),
    duplicate: randomUUID(),
    assistant: randomUUID(),
    chat: randomUUID(),
    restrictedTarget: randomUUID(),
    restrictedCitation: randomUUID(),
    secretProject: randomUUID(),
    old: randomUUID(),
    stillOpen: randomUUID(),
    vote: randomUUID(),
    voteNoTrace: randomUUID(),
    voteRestricted: randomUUID(),
    voteAssistant: randomUUID(),
  };
  const MR_CLOSED = randomUUID();
  const MR_OPEN = randomUUID();

  let prisma: PrismaService;
  let learner: LearnerService;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    const config = { get: (key: string) => ({ LEARNER_WINDOW_DAYS: 30, I18N_DEFAULT_LOCALE: 'ru' })[key] };
    learner = new LearnerService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, config as never);

    await prisma.project.createMany({
      data: [
        { id: P, workspaceId: WS, name: 'e2e mcp learner' },
        { id: SECRET_P, workspaceId: WS, name: 'e2e secret', restricted: true },
      ],
    });
    await prisma.document.createMany({
      data: [
        { id: OPEN, workspaceId: WS, projectId: P, title: 'Open', path: `/${OPEN}/` },
        { id: RESTRICTED, workspaceId: WS, projectId: P, title: 'Restricted', path: `/${RESTRICTED}/`, restricted: true, restrictedBy: [RESTRICTED] },
      ],
    });
    const [main, src] = await Promise.all(
      ['main', 'capture'].map((name) => prisma.documentBranch.create({ data: { documentId: OPEN, name } })),
    );
    const mr = (mrId: string, status: string) =>
      prisma.mergeRequest.create({
        data: { id: mrId, documentId: OPEN, sourceBranchId: src!.id, targetBranchId: main!.id, title: 'capture', authorId: ALICE, status, provenance: 'captured' },
      });
    await mr(MR_CLOSED, 'closed');
    await mr(MR_OPEN, 'open');

    const capture = (cid: string, over: Record<string, unknown> = {}) => ({
      id: cid,
      workspaceId: WS,
      projectId: P,
      kind: 'gotcha',
      status: 'rejected',
      title: `capture ${cid.slice(0, 4)}`,
      payload: { body: 'b' },
      contentHash: cid,
      session: { client: 'claude-code' },
      createdBy: ALICE,
      ...over,
    });
    await prisma.knowledgeCapture.createMany({
      data: [
        capture(id.rejected),
        capture(id.closed, { status: 'proposed', mergeRequestId: MR_CLOSED, targetDocumentId: OPEN }),
        capture(id.stillOpen, { status: 'proposed', mergeRequestId: MR_OPEN }),
        capture(id.duplicate, { status: 'duplicate' }),
        capture(id.assistant, { session: { client: 'assistant' } }),
        capture(id.chat, { session: { client: 'other' }, origin: { platform: 'telegram', chatTitle: null } }),
        capture(id.restrictedTarget, { targetDocumentId: RESTRICTED }),
        capture(id.restrictedCitation, { kind: 'answer', payload: { question: 'q', answer: 'a', citedDocumentIds: [OPEN, RESTRICTED] } }),
        capture(id.secretProject, { projectId: SECRET_P }),
        capture(id.old),
      ] as never,
    });
    const rejected = (subjectId: string, actor: string, createdAt = ago(1), action = 'capture.rejected') => ({
      workspaceId: WS,
      actor,
      action,
      subjectId,
      createdAt,
      metadata: { reason: 'not a gotcha' },
    });
    await prisma.activityLog.createMany({
      data: [
        rejected(id.rejected, ALICE),
        rejected(MR_CLOSED, BOB, ago(2), 'merge-request.closed'),
        rejected(MR_OPEN, BOB, ago(2), 'merge-request.closed'),
        rejected(id.duplicate, ALICE),
        rejected(id.assistant, ALICE),
        rejected(id.chat, ALICE),
        rejected(id.restrictedTarget, ALICE),
        rejected(id.restrictedCitation, ALICE),
        rejected(id.secretProject, ALICE),
        rejected(id.old, ALICE, ago(45)),
      ],
    });
    const vote = (vid: string, over: Record<string, unknown> = {}) => ({
      id: vid,
      workspaceId: WS,
      kind: 'vote',
      surface: 'mcp',
      rating: 'down',
      reason: 'wrong',
      query: 'how is billing rounded',
      traceId: `trace-${vid}`,
      citedDocumentIds: [OPEN],
      createdBy: BOB,
      ...over,
    });
    await prisma.answerFeedback.createMany({
      data: [
        vote(id.vote),
        vote(id.voteNoTrace, { traceId: null }),
        vote(id.voteRestricted, { citedDocumentIds: [OPEN, RESTRICTED] }),
        vote(id.voteAssistant, { surface: 'assistant' }),
      ] as never,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.answerFeedback.deleteMany({ where: { workspaceId: WS } });
    await prisma.activityLog.deleteMany({ where: { workspaceId: WS } });
    await prisma.knowledgeCapture.deleteMany({ where: { workspaceId: WS } });
    await prisma.mergeRequest.deleteMany({ where: { documentId: OPEN } });
    await prisma.documentBranch.deleteMany({ where: { documentId: OPEN } });
    await prisma.document.deleteMany({ where: { workspaceId: WS } });
    await prisma.project.deleteMany({ where: { workspaceId: WS } });
    await prisma.$disconnect();
  });

  it('reads rejected captures, closed captured MRs and downvotes by traceId — and nothing else', async () => {
    const rows = await learner.mcpFailures(WS, now);
    const refs = rows.map((r) => ('captureId' in r ? r.captureId : 'feedbackId' in r ? r.feedbackId : 'run')).sort();
    expect(refs).toEqual([id.rejected, id.closed, id.vote].sort());
    expect(rows.every((r) => r.agentKey === 'mcp' && r.projectId === P && r.locale === 'ru')).toBe(true);
    const byRef = new Map(rows.map((r) => [('captureId' in r ? r.captureId : 'feedbackId' in r ? r.feedbackId : ''), r]));
    // Who turned it down is the activity row's actor; the reason is the detail.
    expect(byRef.get(id.rejected)).toMatchObject({ dismissedBy: ALICE, detail: 'not a gotcha' });
    expect(byRef.get(id.closed)).toMatchObject({ dismissedBy: BOB });
    expect(byRef.get(id.vote)).toMatchObject({ dismissedBy: BOB, kind: 'wrong', title: 'how is billing rounded' });
  });
});
