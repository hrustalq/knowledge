import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { FeedbackBacktestCase, FeedbackVoteLike } from '@knowledge/contracts';
import { feedbackCaseFromVote, scoreFeedbackCase, summarizeFeedbackScores } from '@knowledge/contracts';
import {
  EXPORT_MAX_ROWS,
  FeedbackDatasetService,
  linkMergedFixes,
  REPORT_LINK_WINDOW_MS,
} from '../src/feedback/feedback-dataset.service.js';
import { AnswerFeedbackAdminController } from '../src/feedback/answer-feedback-admin.controller.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Feedback as a backtest dataset (docs/features/38, issue #67 phase 5): which
 * votes become cases and with which labels, how a merged report flips a page
 * from rejected to expected, how a replayed case is scored, and that the
 * export is bounded, streamed and audited.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOC_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T0 = '2026-10-10T10:00:00.000Z';

const vote = (over: Partial<FeedbackVoteLike>): FeedbackVoteLike => ({
  workspaceId: WS,
  query: 'how do refunds work',
  surface: 'assistant',
  rating: 'up',
  reason: null,
  citedDocumentIds: [DOC_A, DOC_B],
  createdAt: T0,
  ...over,
});

describe('feedbackCaseFromVote', () => {
  it('an up-vote expects every cited page and rejects none', () => {
    const c = feedbackCaseFromVote(vote({}));
    expect(c).toMatchObject({ expectedDocumentIds: [DOC_A, DOC_B], rejectedDocumentIds: [], rating: 'up', surface: 'assistant' });
  });

  it('an up-vote that cited nothing (a web-only answer) is no case', () => {
    expect(feedbackCaseFromVote(vote({ citedDocumentIds: [] }))).toBeNull();
  });

  it('a "wrong" or "irrelevant-sources" down-vote rejects the cited pages', () => {
    for (const reason of ['wrong', 'irrelevant-sources'] as const) {
      const c = feedbackCaseFromVote(vote({ rating: 'down', reason }));
      expect(c).toMatchObject({ expectedDocumentIds: [], rejectedDocumentIds: [DOC_A, DOC_B], reason });
    }
  });

  it('a down-vote that blames the wording labels nothing and is no case', () => {
    for (const reason of ['unclear', 'incomplete', 'outdated', 'no-answer', 'other', null] as const) {
      expect(feedbackCaseFromVote(vote({ rating: 'down', reason }))).toBeNull();
    }
  });

  it('a merged fix moves the page from rejected to expected, and only a cited page counts', () => {
    const c = feedbackCaseFromVote(vote({ rating: 'down', reason: 'wrong' }), [DOC_A, DOC_C]);
    expect(c).toMatchObject({ expectedDocumentIds: [DOC_A], rejectedDocumentIds: [DOC_B] });
  });

  it('a merged fix makes a wording down-vote a case too — the page answers now', () => {
    const c = feedbackCaseFromVote(vote({ rating: 'down', reason: 'outdated' }), [DOC_B]);
    expect(c).toMatchObject({ expectedDocumentIds: [DOC_B], rejectedDocumentIds: [] });
  });

  it('a blank question is no case, and cited ids are deduplicated', () => {
    expect(feedbackCaseFromVote(vote({ query: '   ' }))).toBeNull();
    expect(feedbackCaseFromVote(vote({ citedDocumentIds: [DOC_A, DOC_A] }))?.expectedDocumentIds).toEqual([DOC_A]);
  });
});

describe('linkMergedFixes', () => {
  const fix = (over: Partial<{ documentId: string; createdBy: string; createdAt: Date }>) => ({
    documentId: DOC_A,
    createdBy: 'u-alice',
    createdAt: new Date(new Date(T0).getTime() + 5 * 60_000),
    ...over,
  });
  const down = { rating: 'down' as const, citedDocumentIds: [DOC_A, DOC_B], createdAt: T0 };

  it('links the same person, a cited page, filed within the window after the vote', () => {
    expect(linkMergedFixes(down, 'u-alice', [fix({})])).toEqual([DOC_A]);
  });

  it('does not link another person, an uncited page, a report before the vote, or one too late', () => {
    expect(linkMergedFixes(down, 'u-alice', [fix({ createdBy: 'u-bob' })])).toEqual([]);
    expect(linkMergedFixes(down, 'u-alice', [fix({ documentId: DOC_C })])).toEqual([]);
    expect(linkMergedFixes(down, 'u-alice', [fix({ createdAt: new Date(new Date(T0).getTime() - 1) })])).toEqual([]);
    expect(linkMergedFixes(down, 'u-alice', [fix({ createdAt: new Date(new Date(T0).getTime() + REPORT_LINK_WINDOW_MS + 1) })])).toEqual([]);
  });

  it('never links an up-vote', () => {
    expect(linkMergedFixes({ ...down, rating: 'up' }, 'u-alice', [fix({})])).toEqual([]);
  });
});

describe('scoreFeedbackCase / summarizeFeedbackScores', () => {
  const c = (over: Partial<FeedbackBacktestCase>): FeedbackBacktestCase => ({
    workspaceId: WS,
    query: 'q',
    surface: 'ask',
    rating: 'up',
    reason: null,
    expectedDocumentIds: [DOC_A],
    rejectedDocumentIds: [],
    createdAt: T0,
    ...over,
  });

  it('scores rank 1, rank k and a miss over the expected pages', () => {
    expect(scoreFeedbackCase(c({}), [DOC_A, DOC_B], 10)).toEqual({ hitAt1: true, hitAtK: true, reciprocalRank: 1, rejectedInTopK: null });
    expect(scoreFeedbackCase(c({}), [DOC_B, DOC_C, DOC_A], 10)).toMatchObject({ hitAt1: false, hitAtK: true, reciprocalRank: 1 / 3 });
    expect(scoreFeedbackCase(c({}), [DOC_B, DOC_C, DOC_A], 2)).toMatchObject({ hitAt1: false, hitAtK: false, reciprocalRank: 0 });
  });

  it('scores rejected pages only within the head, and leaves the other labels null', () => {
    const rej = c({ rating: 'down', reason: 'wrong', expectedDocumentIds: [], rejectedDocumentIds: [DOC_B] });
    expect(scoreFeedbackCase(rej, [DOC_A, DOC_B], 10)).toEqual({ hitAt1: null, hitAtK: null, reciprocalRank: null, rejectedInTopK: true });
    expect(scoreFeedbackCase(rej, [DOC_A, DOC_B], 1)).toMatchObject({ rejectedInTopK: false });
  });

  it('summarises over the cases that carry each label', () => {
    const m = summarizeFeedbackScores([
      scoreFeedbackCase(c({}), [DOC_A], 10),
      scoreFeedbackCase(c({}), [DOC_B, DOC_A], 10),
      scoreFeedbackCase(c({ rating: 'down', reason: 'wrong', expectedDocumentIds: [], rejectedDocumentIds: [DOC_B] }), [DOC_B], 10),
    ]);
    expect(m).toEqual({ cases: 3, withExpected: 2, hitAt1: 1, hitAtK: 2, mrr: 0.75, withRejected: 1, rejectedInTopK: 1 });
  });
});

// --- the service over a Prisma mock ------------------------------------------

function row(over: Record<string, unknown>) {
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: WS,
    kind: 'vote',
    surface: 'assistant',
    rating: 'up',
    reason: null,
    comment: null,
    query: 'how do refunds work',
    answerExcerpt: 'Refunds take 5 days.',
    threadId: null,
    messageId: null,
    traceId: null,
    citedDocumentIds: [DOC_A],
    confidence: null,
    createdBy: 'u-alice',
    apiKeyId: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...over,
  };
}

function prismaWith(rows: Array<ReturnType<typeof row>>, extra: { issues?: unknown[]; mergedIds?: string[] } = {}) {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return {
    answerFeedback: {
      findMany: vi.fn(async ({ where, take, cursor, skip }: { where: Record<string, unknown>; take: number; cursor?: { id: string }; skip?: number }) => {
        let list = sorted.filter((r) => (where.kind ? r.kind === where.kind : true) && (where.rating ? r.rating === where.rating : true));
        if (cursor) list = list.slice(list.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
        return list.slice(0, take);
      }),
    },
    knowledgeIssue: {
      findMany: vi.fn(async () => extra.issues ?? []),
      groupBy: vi.fn(async () => [{ status: 'open', _count: { _all: 2 } }]),
    },
    mergeRequest: { findMany: vi.fn(async () => (extra.mergedIds ?? []).map((id) => ({ id }))) },
    document: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, title: `Page ${id.slice(0, 4)}` }))) },
    $queryRaw: vi.fn(async () => [
      { kind: 'vote', surface: 'assistant', rating: 'up', reason: null, cited: true, count: 3n },
      { kind: 'vote', surface: 'ask', rating: 'down', reason: 'wrong', cited: true, count: 2n },
      { kind: 'vote', surface: 'ask', rating: 'down', reason: 'unclear', cited: true, count: 1n },
      { kind: 'low-confidence', surface: 'mcp', rating: null, reason: null, cited: false, count: 4n },
    ]),
  };
}

async function collect(service: FeedbackDatasetService) {
  const out: FeedbackBacktestCase[] = [];
  const stream = service.cases(WS, {});
  let next = await stream.next();
  while (!next.done) {
    out.push(next.value);
    next = await stream.next();
  }
  return { cases: out, end: next.value };
}

describe('FeedbackDatasetService', () => {
  it('list pages newest first with titles resolved, and a cursor only when a page is full', async () => {
    const rows = [row({ id: 'f-1', createdAt: new Date('2026-10-10T10:00:00Z') }), row({ id: 'f-2', createdAt: new Date('2026-10-10T11:00:00Z') })];
    const service = new FeedbackDatasetService(prismaWith(rows) as never);
    const page = await service.list(WS, { limit: 1 });
    expect(page.entries.map((e) => e.id)).toEqual(['f-2']);
    expect(page.entries[0].citedDocuments).toEqual([{ id: DOC_A, title: `Page ${DOC_A.slice(0, 4)}` }]);
    expect(page.entries[0].answerExcerpt).toBe('Refunds take 5 days.');
    expect(page.nextCursor).toBe('f-2');
    const rest = await service.list(WS, { limit: 1, cursor: 'f-2' });
    expect(rest.entries.map((e) => e.id)).toEqual(['f-1']);
    expect(rest.nextCursor).toBeNull();
  });

  it('list refuses a value outside the vocabulary and a bad date with a 400', async () => {
    const service = new FeedbackDatasetService(prismaWith([]) as never);
    await expect(service.list(WS, { reason: 'bogus' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(WS, { surface: 'slack' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(WS, { from: 'yesterday' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(WS, { reason: 'wrong', surface: 'ask' })).resolves.toMatchObject({ entries: [] });
  });

  it('summary folds the grouped counts and counts only the votes the export would use', async () => {
    const service = new FeedbackDatasetService(prismaWith([]) as never);
    const s = await service.summary(WS, {});
    expect(s.votes).toEqual({ up: 3, down: 3 });
    expect(s.signals).toEqual({ 'low-confidence': 4, 'no-answer': 0 });
    expect(s.byReason).toEqual([{ reason: 'wrong', count: 2 }, { reason: 'unclear', count: 1 }]);
    expect(s.bySurface).toEqual([{ surface: 'assistant', count: 3 }, { surface: 'ask', count: 3 }, { surface: 'mcp', count: 4 }]);
    expect(s.issues).toEqual([{ status: 'open', count: 2 }]);
    expect(s.datasetVotes).toBe(5);
    await expect(service.summary(WS, { from: '2026-10-11T00:00:00Z', to: '2026-10-10T00:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cases skips signals and unusable votes, and joins a merged report to the vote that filed it', async () => {
    const votedAt = new Date(T0);
    const rows = [
      row({ id: 'f-up', createdAt: votedAt }),
      row({ id: 'f-down', rating: 'down', reason: 'wrong', citedDocumentIds: [DOC_A, DOC_B], createdAt: new Date(votedAt.getTime() - 1_000) }),
      row({ id: 'f-sig', kind: 'low-confidence', rating: null, createdAt: new Date(votedAt.getTime() - 2_000) }),
      row({ id: 'f-web', citedDocumentIds: [], createdAt: new Date(votedAt.getTime() - 3_000) }),
    ];
    const issues = [
      { documentId: DOC_B, createdBy: 'u-alice', createdAt: new Date(votedAt.getTime() + 60_000), mergeRequestId: 'mr-merged' },
      { documentId: DOC_A, createdBy: 'u-alice', createdAt: new Date(votedAt.getTime() + 60_000), mergeRequestId: 'mr-open' },
    ];
    const prisma = prismaWith(rows, { issues, mergedIds: ['mr-merged'] });
    const { cases, end } = await collect(new FeedbackDatasetService(prisma as never));
    expect(end).toEqual({ read: 3, truncated: false });
    expect(cases.map((c) => [c.rating, c.expectedDocumentIds, c.rejectedDocumentIds])).toEqual([
      ['up', [DOC_A], []],
      ['down', [DOC_B], [DOC_A]],
    ]);
    // Only votes are read: the signal row never reaches the builder.
    expect(prisma.answerFeedback.findMany.mock.calls[0][0].where).toMatchObject({ kind: 'vote' });
  });

  it('cases stops at the export bound and says so', async () => {
    const service = new FeedbackDatasetService(prismaWith([]) as never);
    const many = Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => row({ id: `f-${String(i).padStart(6, '0')}` }));
    const prisma = prismaWith(many);
    const { cases, end } = await collect(new FeedbackDatasetService(prisma as never));
    expect(cases).toHaveLength(EXPORT_MAX_ROWS);
    expect(end).toEqual({ read: EXPORT_MAX_ROWS, truncated: true });
    expect(service).toBeDefined();
  });
});

describe('AnswerFeedbackAdminController.export', () => {
  const admin: Principal = { userId: 'u-admin', email: 'a@x.test', displayName: 'A', avatarUrl: null, mode: 'session', isAdmin: true, locale: 'en' };

  function fakeRes() {
    const headers: Record<string, string> = {};
    const chunks: string[] = [];
    return {
      headers,
      chunks,
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      status: vi.fn(),
      write: vi.fn((s: string) => chunks.push(s)),
      end: vi.fn(),
      destroy: vi.fn(),
    };
  }

  it('streams one JSON line per case as NDJSON and writes one audit row with the count', async () => {
    const rows = [row({ id: 'f-1' }), row({ id: 'f-2', createdAt: new Date('2026-10-10T09:00:00Z') })];
    const audit = { record: vi.fn(async () => undefined) };
    const ctrl = new AnswerFeedbackAdminController(new FeedbackDatasetService(prismaWith(rows) as never), audit as never);
    const res = fakeRes();
    await ctrl.export(WS, admin, res as never, undefined, undefined);
    expect(res.headers['Content-Type']).toContain('application/x-ndjson');
    expect(res.headers['Content-Disposition']).toContain('.ndjson');
    expect(res.chunks).toHaveLength(2);
    for (const line of res.chunks) expect(JSON.parse(line)).toMatchObject({ workspaceId: WS, expectedDocumentIds: [DOC_A] });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'feedback.export', actor: 'u-admin', rowCount: 2, ok: true, params: { read: 2, truncated: false } });
  });

  it('a bad window is a 400 before any header is written — refused, so nothing to audit', async () => {
    const audit = { record: vi.fn(async () => undefined) };
    const ctrl = new AnswerFeedbackAdminController(new FeedbackDatasetService(prismaWith([]) as never), audit as never);
    const res = fakeRes();
    await expect(ctrl.export(WS, admin, res as never, 'not-a-date', undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
