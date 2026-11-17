import { describe, expect, it, vi } from 'vitest';
import type { ContextPage, SearchResult } from '@knowledge/contracts';
import { CONTEXT_BUDGET } from '@knowledge/contracts';
import { ContextService, clampBudget, clip, matchTerms, packContext, CONTEXT_TOOL } from '../src/context/context.service.js';
import { repositorySegments } from '../src/components/component-match.js';
import { estimateTokens } from '../src/ai/ai-usage.service.js';
import { pageText } from '../src/common/page-text.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

/** #1194: ticket context answers pointers inside a hard budget, and only what the caller may read. */

const WS = '11111111-1111-4111-8111-111111111111';
const OPEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const page = (i: number, excerpt = 'x'.repeat(180)): ContextPage => ({ documentId: `d-${i}`, title: `Page ${i}`, status: 'verified', excerpt });
const rendered = (r: object) => estimateTokens(pageText(r, CONTEXT_TOOL));

describe('packContext', () => {
  it('never exceeds the budget, drops whole items, and fills pages before memory before terms', () => {
    const pages = [page(1), page(2), page(3), page(4)];
    const out = packContext({ pages, memories: [], terms: [] }, [OPEN], 200);
    expect(out.tokens).toBeLessThanOrEqual(200);
    expect(out.tokens).toBe(rendered(out));
    expect(out.pages.length).toBeGreaterThan(0);
    expect(out.pages.length).toBeLessThan(4);
    for (const p of out.pages) expect(pages).toContainEqual(p); // never cut
  });

  it('a whole item that does not fit is dropped, and the next one is still tried', () => {
    const small = page(1, 'short');
    const memory = { id: 'm-1', status: 'unverified' as const, bankId: `project:${OPEN}`, occurredAt: null, text: 'y'.repeat(200) };
    const term = { termId: 't-1', term: 'SLA', definition: 'Service level agreement', documentId: null };
    // Exactly the room for the small page and the term.
    const budget = packContext({ pages: [small], memories: [], terms: [term] }, [OPEN], CONTEXT_BUDGET.max).tokens;
    const out = packContext({ pages: [small, page(2)], memories: [memory], terms: [term] }, [OPEN], budget);
    expect(out.pages).toEqual([small]);
    expect(out.memories).toEqual([]);
    expect(out.terms).toEqual([term]);
    expect(out.tokens).toBeLessThanOrEqual(budget);
  });

  it('keeps everything that fits the default budget', () => {
    const out = packContext({ pages: [page(1, 'short'), page(2, 'short')], memories: [], terms: [] }, [], CONTEXT_BUDGET.default);
    expect(out.pages).toHaveLength(2);
    expect(out.tokens).toBeLessThanOrEqual(CONTEXT_BUDGET.default);
  });

  // #1211: worst-case items under today's caps — long titles, full 200-character excerpts, ids and dates on everything.
  const UUID = (n: number) => `${String(n).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const fullPage = (i: number): ContextPage => ({ documentId: UUID(i), title: `${'T'.repeat(78)} ${i}`, status: 'outdated', excerpt: 'x'.repeat(200) });
  const fullMemory = (i: number) => ({
    id: UUID(i + 4),
    status: 'unverified' as const,
    bankId: `project:${OPEN}`,
    occurredAt: '2026-11-16T12:00:00.000Z',
    text: 'y'.repeat(200),
  });
  const fullTerm = (i: number) => ({ termId: UUID(i + 7), term: `Term ${i}`.padEnd(40, 't'), definition: 'z'.repeat(200), documentId: UUID(i) });

  it('the minimum budget holds the wrapper and all four pages with full excerpts', () => {
    const pages = [1, 2, 3, 4].map(fullPage);
    const out = packContext({ pages, memories: [], terms: [] }, [OPEN], clampBudget(200));
    expect(out.pages).toEqual(pages);
  });

  it('the default budget holds a full answer', () => {
    const candidates = { pages: [1, 2, 3, 4].map(fullPage), memories: [1, 2, 3].map(fullMemory), terms: [1, 2, 3].map(fullTerm) };
    expect(packContext(candidates, [OPEN], clampBudget(undefined))).toMatchObject(candidates);
  });

  it('nothing relevant is one plain line', () => {
    const out = packContext({ pages: [], memories: [], terms: [] }, [], CONTEXT_BUDGET.default);
    expect(out).toMatchObject({ empty: true, reason: 'nothing-relevant' });
    expect(pageText(out, CONTEXT_TOOL).split('\n')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('clamps the budget', () => {
    expect(clampBudget(undefined)).toBe(1200);
    expect(clampBudget(200)).toBe(600);
    expect(clampBudget(5000)).toBe(4000);
  });

  it('clips to 200 characters', () => {
    expect(clip('a'.repeat(500))).toHaveLength(200);
    expect(clip('short')).toBe('short');
  });

  it('reads a git remote in scp, https and ssh form as the same repository', () => {
    const want = 'github.com/org/repo';
    for (const remote of ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'https://github.com/org/repo.git', 'ssh://git@github.com/org/repo.git']) {
      expect(repositorySegments(remote).join('/')).toBe(want);
    }
  });

  it('matches glossary terms as words, longest spelling first, honouring aliases and case', () => {
    const t = (id: string, term: string, extra: Partial<{ aliases: string[]; matchAliases: boolean; caseSensitive: boolean }> = {}) => ({
      id,
      term,
      aliases: [],
      matchAliases: true,
      caseSensitive: false,
      ...extra,
    });
    const terms = [
      t('order', 'Order'),
      t('order-service', 'Order service'),
      t('it', 'IT', { caseSensitive: true }),
      t('kyc', 'Know your customer', { aliases: ['KYC'] }),
      t('sla', 'Service level', { aliases: ['SLA'], matchAliases: false }),
    ];
    expect(matchTerms('Fix the order service timeout for KYC; ask it about SLA', terms, 3).map((x) => x.id)).toEqual(['order-service', 'kyc']);
    expect(matchTerms('reorder the queue', terms, 3)).toEqual([]);
    expect(matchTerms('page IT about the order', terms, 3).map((x) => x.id)).toEqual(['it', 'order']);
  });
});

describe('ContextService', () => {
  const hit = (id: string, vectorScore: number | undefined, status: 'verified' | 'outdated' = 'verified'): SearchResult => ({
    documentId: id,
    revisionId: `r-${id}`,
    chunkId: `c-${id}`,
    title: `T ${id}`,
    snippet: 'raw',
    snippetParts: [
      { text: 'The ', hit: false },
      { text: 'billing', hit: true },
      { text: ' runbook says '.padEnd(400, 'z'), hit: false },
    ],
    score: 1,
    ...(vectorScore === undefined ? {} : { vectorScore }),
    trust: { status, inactive: false },
  });

  function build(results: SearchResult[]) {
    const prisma = {
      connector: {
        findMany: vi.fn(async () => [
          { projectId: OPEN, config: { repoUrl: 'https://github.com/org/repo' } },
          { projectId: SECRET, config: { repoUrl: 'https://github.com/org/repo.git' } },
          { projectId: 'other', config: { repoUrl: 'https://github.com/org/else' } },
        ]),
      },
      project: {
        findUnique: vi.fn(async () => ({ blueprintId: null })),
        findMany: vi.fn(async (q: { where: { id: { in: string[] } } }) =>
          [{ id: OPEN, restricted: false }, { id: SECRET, restricted: true }].filter((p) => q.where.id.in.includes(p.id)),
        ),
      },
      glossaryTerm: { findMany: vi.fn(async () => [{ id: 't-1', projectId: null, term: 'billing', aliases: [], definition: 'Money\nmore', documentId: null, enabled: true, matchAliases: true, caseSensitive: false }]) },
    };
    const search = { search: vi.fn(async () => ({ results })) };
    const memory = { recallProjects: vi.fn(async () => []) };
    const analytics = { search: vi.fn(() => 'sq-1') };
    const config = { get: () => 0.4 };
    const svc = new ContextService(prisma as never, search as never, memory as never, analytics as never, config as never);
    return { svc, search, memory, analytics };
  }
  const outsider: AccessScope = { workspaceId: WS, userId: 'u-1', role: 'editor', bypass: false, guest: false, readOnly: false, groupIds: new Set(), denied: new Set([SECRET]), granted: new Set() };
  const caller = { principal: { userId: 'u-1' } as never };

  it('keeps the search order (outdated below verified), drops what is excluded or under the floor, and excerpts 200 characters', async () => {
    const { svc, analytics } = build([hit('a', 0.8), hit('gone', 0.9), hit('b', undefined), hit('weak', 0.2), hit('c', 0.5, 'outdated')]);
    const res = await svc.context({ workspaceId: WS, query: 'billing timeout', exclude: ['gone'] }, outsider, caller);
    expect(res.pages.map((p) => [p.documentId, p.status])).toEqual([
      ['a', 'verified'],
      ['b', 'verified'],
      ['c', 'outdated'],
    ]);
    expect(res.pages[0]).toMatchObject({ match: 'billing' });
    expect(res.pages.every((p) => p.excerpt.length <= 200)).toBe(true);
    expect(res.terms).toEqual([{ termId: 't-1', term: 'billing', definition: 'Money', documentId: null }]);
    expect(analytics.search).toHaveBeenCalledWith(caller, expect.objectContaining({ mode: 'context', resultDocIds: ['a', 'b', 'c'] }));
  });

  it('resolves the repo to the projects the caller may see, and reads memory from those alone', async () => {
    const { svc, memory } = build([]);
    const res = await svc.context({ workspaceId: WS, query: 'q', repo: 'git@github.com:org/repo.git' }, outsider, caller);
    expect(res.projectIds).toEqual([OPEN]);
    expect(memory.recallProjects).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [OPEN] }));
  });

  it('answers empty when nothing passes a floor', async () => {
    const { svc } = build([hit('weak', 0.1)]);
    const res = await svc.context({ workspaceId: WS, query: 'unrelated words' }, outsider, caller);
    expect(res).toMatchObject({ empty: true, reason: 'nothing-relevant', pages: [], terms: [], memories: [] });
  });
});
