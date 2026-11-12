import { describe, expect, it, vi } from 'vitest';
import { AI_USAGE_UNATTRIBUTED } from '@knowledge/contracts';
import { projectOfRun } from '../src/ai/run-project.js';
import { AiUsageService } from '../src/ai/ai-usage.service.js';
import { withAgentRun } from '../src/ai/agent-run-context.js';

/**
 * Model usage and agent runs attributed to a project (#927): resolved once
 * (`projectOfRun` for a run, the recorder for a call), unattributed when
 * nothing names a single project, and never able to fail the model call.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const PAGE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const MR = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const MEMO = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const CONNECTOR = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

const db = {
  document: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id === PAGE_A || id === PAGE_B).map((id) => ({ projectId: id === PAGE_A ? A : B })),
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === PAGE_A ? { projectId: A } : null)),
  },
  mergeRequest: { findUnique: vi.fn(async () => ({ documentId: PAGE_B })) },
  knowledgeIssue: { findFirst: vi.fn(async () => ({ documentId: PAGE_A })) },
  memo: { findFirst: vi.fn(async () => ({ projectId: A })) },
  connector: { findFirst: vi.fn(async () => ({ projectId: B })) },
};
const run = (subjectKey: string | null, input: unknown = null) => ({ workspaceId: WS, subjectKey, input });

describe('projectOfRun', () => {
  it("takes the project of the page a run is about, however the run names it", async () => {
    expect(await projectOfRun(db as never, run(`doc:${PAGE_A}`))).toBe(A);
    expect(await projectOfRun(db as never, run(null, { documentIds: [PAGE_A] }))).toBe(A);
    expect(await projectOfRun(db as never, run(null, { apiTestSuite: { documentId: PAGE_B, entityKey: 'k', revisionId: 'r' } }))).toBe(B);
    expect(await projectOfRun(db as never, run(`mr:${MR}`))).toBe(B);
    expect(await projectOfRun(db as never, run(null, { issueId: MR }))).toBe(A);
  });

  it("falls to the memo's or the connector's project when no page is named", async () => {
    expect(await projectOfRun(db as never, run(`memo:${MEMO}`, { memo: { memoId: MEMO } }))).toBe(A);
    expect(await projectOfRun(db as never, run(`connector:${CONNECTOR}`))).toBe(B);
  });

  it('leaves a run unattributed when it names nothing, or pages of several projects', async () => {
    expect(await projectOfRun(db as never, run(null))).toBeNull();
    expect(await projectOfRun(db as never, run('webhook:delivery-17', { payload: 'x' }))).toBeNull();
    expect(await projectOfRun(db as never, run(null, { documentIds: [PAGE_A, PAGE_B] }))).toBeNull();
  });
});

function usage(opts: { threadPage?: string | null; threadFails?: boolean; rows?: Array<Record<string, unknown>> } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    aiUsage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void created.push(data)),
      findMany: vi.fn(async () => opts.rows ?? []),
    },
    assistantThread: {
      findUnique: vi.fn(async () => {
        if (opts.threadFails) throw new Error('db down');
        return { documentId: opts.threadPage ?? null };
      }),
    },
    document: db.document,
    project: { findMany: vi.fn(async () => [{ id: A, name: 'Billing' }]) },
  };
  const svc = new AiUsageService(prisma as never, { estimateCost: () => null } as never);
  const call = (extra: Record<string, unknown> = {}) =>
    svc.record({
      config: { workspaceId: WS, provider: 'openai', model: 'm', providerId: null } as never,
      userId: 'u',
      operation: 'lint',
      tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false },
      durationMs: 1,
      ok: true,
      ...extra,
    });
  return { svc, call, created, prisma };
}

describe('AiUsageService.record', () => {
  it("stamps a call made inside a run with the run's project", async () => {
    const { call, created } = usage();
    await withAgentRun({ agentKey: 'linter', agentRunId: 'r1', projectId: A }, () => call());
    expect(created[0]).toMatchObject({ agentKey: 'linter', agentRunId: 'r1', projectId: A });
  });

  it("attributes a thread's call to its page's project, and a call that names nothing to none", async () => {
    const onPage = usage({ threadPage: PAGE_A });
    await onPage.call({ threadId: 't1' });
    expect(onPage.created[0]!.projectId).toBe(A);
    const loose = usage();
    await loose.call();
    await loose.call({ threadId: 't2' });
    expect(loose.created.map((r) => r.projectId)).toEqual([null, null]);
  });

  it('prefers what the caller passed, and never loses the row to a failed lookup', async () => {
    const { call, created } = usage({ threadFails: true });
    await call({ threadId: 't1', projectId: B });
    await call({ threadId: 't1' });
    expect(created.map((r) => r.projectId)).toEqual([B, null]);
  });
});

describe('AiUsageService.summarize by project', () => {
  it('sums to the workspace total, with unattributed calls in a bucket of their own', async () => {
    const row = (projectId: string | null, totalTokens: number) => ({
      userId: 'u', model: 'm', projectId, promptTokens: totalTokens, completionTokens: 0, totalTokens, costMicros: null, costCurrency: 'USD', ok: true, createdAt: new Date('2026-11-01T10:00:00Z'),
    });
    const { svc } = usage({ rows: [row(A, 100), row(A, 50), row(null, 30), row(B, 5)] });
    const res = await svc.summarize(WS, { groupBy: 'project' });
    expect(res.buckets.map((b) => [b.key, b.label, b.totalTokens])).toEqual([
      [A, 'Billing', 150],
      [AI_USAGE_UNATTRIBUTED, AI_USAGE_UNATTRIBUTED, 30],
      [B, B, 5], // a project deleted since keeps its id
    ]);
    expect(res.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(res.totals.totalTokens);
  });
});
