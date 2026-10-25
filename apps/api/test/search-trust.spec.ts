import { describe, expect, it, vi } from 'vitest';
import { SEARCH_RRF_K, TRUST_WEIGHTS } from '@knowledge/contracts';
import { SearchService } from '../src/search/search.service.js';
import { communityPrior, firstPerPage, rankPool, type PriorCommunity, type SearchKnobs, type SearchPool } from '../src/search/ranking.js';
import { CommunitiesService } from '../src/communities/communities.service.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import { emitBacktest } from '@knowledge/observability';

vi.mock('@knowledge/observability', async (actual) => ({ ...(await actual<object>()), emitBacktest: vi.fn() }));

/**
 * The trust re-rank (docs/features/39): archived pages drop, a page's state
 * multiplies its fused score, the cut to k happens after the re-sort, the
 * kill switch restores the old order and the old candidate count exactly, and
 * every hit says what it was ranked by.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const NOW = Date.now();
const day = 86_400_000;

type Row = {
  id: string;
  title: string;
  category: string;
  projectId: string;
  defaultBranch: string;
  verifiedAt: Date | null;
  verifiedRevisionId: string | null;
  verificationExpiresAt: Date | null;
  verificationFlag: string | null;
  ownerId: string | null;
  lastActivityAt: Date;
  archivedAt: Date | null;
  branches: { name: string; headRevisionId: string | null }[];
};

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    title: id,
    category: 'guide',
    projectId: 'p',
    defaultBranch: 'main',
    verifiedAt: null,
    verifiedRevisionId: null,
    verificationExpiresAt: null,
    verificationFlag: null,
    ownerId: null,
    lastActivityAt: new Date(NOW - day),
    archivedAt: null,
    branches: [{ name: 'main', headRevisionId: 'head' }],
    ...over,
  };
}

function hit(documentId: string, score: number) {
  return { documentId, revisionId: 'head', chunkId: `c-${documentId}`, text: `text of ${documentId}`, headingPath: [], score };
}

/** An admin's scope: sees everything, so these cases measure ranking alone. */
const ADMIN = systemScope(WS);

function build(
  docs: Row[],
  hits: ReturnType<typeof hit>[],
  trustRanking = true,
  textHits: ReturnType<typeof hit>[] = [],
  knobs: Partial<SearchKnobs & { layeredExpansion: boolean }> = {},
  communities: { scored: (scope: unknown, embedding?: number[]) => Promise<unknown[]> } = { scored: async () => [] },
  resolve: () => Promise<unknown> = async () => undefined,
) {
  const analytics = { search: vi.fn(() => 'search-1') };
  const prisma = {
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; archivedAt?: unknown } }) =>
        docs.filter((d) => where.id.in.includes(d.id) && (where.archivedAt === undefined || d.archivedAt)),
      ),
      // An asOf search reads each result's revision stamps (#81); none here.
      findUnique: vi.fn(async () => null),
    },
    componentDeclaration: { findMany: vi.fn(async () => []) },
  };
  const graph = {
    entityKeysOf: vi.fn(async () => new Map<string, string[]>()),
    searchChunks: vi.fn(async (_ws: string, _e: number[], k: number) => hits.slice(0, k)),
    getDocumentIdsByTags: vi.fn(async () => new Set<string>()),
    getWorkspaceRelationGraph: vi.fn(async () => ({ edges: [], entities: {}, documents: {} })),
  };
  const embeddings = { embed: vi.fn(async () => [0.1, 0.2]) };
  const fulltext = { enabled: textHits.length > 0, search: vi.fn(async (_ws: string, _q: string, k: number) => textHits.slice(0, k)) };
  const provenance = { openIssueCounts: vi.fn(async () => new Map<string, number>()) };
  const policy = {
    effective: vi.fn(async () => ({
      reviewIntervalDays: 90,
      remindBeforeDays: 7,
      inactiveAfterDays: 180,
      emptyMaxChars: 40,
      trustRanking,
      rrfK: SEARCH_RRF_K,
      // Floor off unless a case sets it: the cases above measure ranking alone.
      minCosine: 0,
      minCosineShare: 0,
      communityPriorWeight: 0,
      communityPriorFloor: 0.5,
      layeredExpansion: false,
      trustWeights: TRUST_WEIGHTS,
      ...knobs,
    })),
  };
  const permissions = { documentFilterFor: vi.fn(async () => ({ kind: 'all' as const })) };
  const config = { get: vi.fn((key: string) => ({ SEARCH_ACL_OVERFETCH: 5, SEARCH_ACL_MAX_FETCH: 500 })[key]) };
  const svc = new SearchService(
    prisma as never,
    graph as never,
    embeddings as never,
    fulltext as never,
    provenance as never,
    policy as never,
    permissions as never,
    config as never,
    // No asOf unless a case passes one: the live projection (#81).
    { resolve } as never,
    analytics as never,
    // No communities built unless a case passes some (#475).
    communities as never,
  );
  return { svc, graph, prisma, analytics };
}

const verified = row('verified', { verifiedAt: new Date(NOW - day), verifiedRevisionId: 'head', verificationExpiresAt: new Date(NOW + 30 * day) });
const plain = row('plain');
const expired = row('expired', { verifiedAt: new Date(NOW - 100 * day), verifiedRevisionId: 'head', verificationExpiresAt: new Date(NOW - day) });
const outdated = row('outdated', { verificationFlag: 'outdated' });
const archived = row('archived', { archivedAt: new Date() });
const inactive = row('inactive', { lastActivityAt: new Date(NOW - 400 * day) });

describe('SearchService trust re-rank', () => {
  it('ranks equally relevant pages verified > unverified > expired > outdated and attaches trust to every hit', async () => {
    const { svc } = build(
      [verified, plain, expired, outdated],
      [hit('outdated', 0.5), hit('expired', 0.5), hit('plain', 0.5), hit('verified', 0.5)],
    );
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, ADMIN);
    expect(res.results.map((r) => r.documentId)).toEqual(['verified', 'plain', 'expired', 'outdated']);
    expect(res.results.map((r) => r.trust?.status)).toEqual(['verified', 'unverified', 'expired', 'outdated']);
    expect(res.results[0]!.score).toBeCloseTo(0.5 * TRUST_WEIGHTS.verified, 4);
    expect(res.results[3]!.score).toBeCloseTo(0.5 * TRUST_WEIGHTS.outdated, 4);
    expect(res.results[0]!.trust).toMatchObject({ verifiedAt: verified.verifiedAt!.toISOString(), inactive: false });
  });

  it('drops archived pages and marks inactivity, then cuts to k after the re-sort', async () => {
    const { svc, graph } = build(
      [verified, archived, inactive, outdated],
      [hit('archived', 0.9), hit('outdated', 0.8), hit('inactive', 0.7), hit('verified', 0.5)],
    );
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 2 }, ADMIN);
    // At least 2k candidates were asked for so the demoted hits could be displaced:
    // the archived top hit drops, the outdated one sinks under the verified one.
    expect(graph.searchChunks).toHaveBeenCalledWith(WS, expect.any(Array), 4, { kind: 'all' }, undefined);
    expect(res.results.map((r) => r.documentId)).toEqual(['inactive', 'verified']);
    expect(res.results[0]!.trust).toMatchObject({ status: 'unverified', inactive: true });
    expect(res.results[0]!.score).toBeCloseTo(0.7 * TRUST_WEIGHTS.inactive, 4);
  });

  it('includeArchived keeps archived pages and verificationStates narrows the hit set', async () => {
    const { svc } = build([verified, plain, archived], [hit('archived', 0.9), hit('plain', 0.6), hit('verified', 0.5)]);
    const withArchived = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', filters: { includeArchived: true } }, ADMIN);
    expect(withArchived.results.map((r) => r.documentId)).toContain('archived');

    const onlyVerified = await svc.search({
      workspaceId: WS,
      query: 'q',
      mode: 'semantic',
      filters: { verificationStates: ['verified'] },
    }, ADMIN);
    expect(onlyVerified.results.map((r) => r.documentId)).toEqual(['verified']);
  });

  it('with the switch off, the order and the candidate count are exactly the pre-#66 ones', async () => {
    const { svc, graph } = build(
      [verified, plain, expired, outdated],
      [hit('outdated', 0.8), hit('expired', 0.7), hit('plain', 0.6), hit('verified', 0.5)],
      false,
    );
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 3 }, ADMIN);
    expect(graph.searchChunks).toHaveBeenCalledWith(WS, expect.any(Array), 3, { kind: 'all' }, undefined);
    expect(res.results.map((r) => r.documentId)).toEqual(['outdated', 'expired', 'plain']);
    expect(res.results.map((r) => r.score)).toEqual([0.8, 0.7, 0.6]);
    // The status still travels with the hit; only the weight is off.
    expect(res.results[0]!.trust?.status).toBe('outdated');
  });

  it('still drops archived pages with the switch off: archive is not a demotion', async () => {
    const { svc } = build([plain, archived], [hit('archived', 0.9), hit('plain', 0.6)], false);
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, ADMIN);
    expect(res.results.map((r) => r.documentId)).toEqual(['plain']);
  });
});

describe('SearchService analytics (#79)', () => {
  it('files a search that names its caller, with the pages it returned, and hands back its id', async () => {
    const { svc, analytics } = build([verified, plain], [hit('plain', 0.5), hit('verified', 0.5)]);
    const caller = { principal: DEV_PRINCIPAL, channel: 'mcp' as const };
    const res = await svc.search({ workspaceId: WS, query: 'billing', mode: 'semantic' }, ADMIN, caller);
    expect(res.searchId).toBe('search-1');
    expect(analytics.search).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({ workspaceId: WS, query: 'billing', mode: 'semantic', projectIds: [], resultDocIds: ['verified', 'plain'] }),
    );
  });

  it('files an empty search too, and nothing for a search with no caller', async () => {
    const { svc, analytics } = build([], []);
    const caller = { principal: DEV_PRINCIPAL };
    expect((await svc.search({ workspaceId: WS, query: 'nothing' }, ADMIN, caller)).searchId).toBe('search-1');
    expect(analytics.search).toHaveBeenLastCalledWith(caller, expect.objectContaining({ resultDocIds: [] }));
    analytics.search.mockClear();
    expect((await svc.search({ workspaceId: WS, query: 'nothing' }, ADMIN)).searchId).toBeUndefined();
    expect(analytics.search).not.toHaveBeenCalled();
  });
});

describe('SearchService knobs (#305)', () => {
  const docs = [verified, plain, expired, outdated, inactive, archived];
  const vector = [hit('outdated', 0.9), hit('plain', 0.8), hit('archived', 0.7), hit('verified', 0.6), hit('expired', 0.5)];
  const text = [hit('verified', 9), hit('inactive', 8), hit('expired', 7), hit('plain', 6)];

  it('the pool it hands make tune re-ranks to exactly what it returned, under any knobs', async () => {
    for (const knobs of [
      {},
      { rrfK: 5 },
      { rrfK: 200, trustWeights: { ...TRUST_WEIGHTS, verified: 0.3, outdated: 1.25 } },
      { minCosineShare: 0.85 },
      { minCosine: 0.75, minCosineShare: 0.5 },
    ]) {
      const { svc } = build(docs, vector, true, text, knobs);
      let pool = null as SearchPool | null;
      const res = await svc.search({ workspaceId: WS, query: 'q', limit: 3 }, ADMIN, undefined, (p) => (pool = p));
      expect(rankPool(pool!, { rrfK: SEARCH_RRF_K, minCosine: 0, minCosineShare: 0, communityPriorWeight: 0, communityPriorFloor: 0.5, trustWeights: TRUST_WEIGHTS, ...knobs })).toEqual(
        res.results.map((r) => r.documentId),
      );
    }
  });

  it('the fusion constant and the weights come from the workspace settings', async () => {
    const at = async (knobs: Partial<SearchKnobs>) =>
      (await build(docs, vector, true, text, knobs).svc.search({ workspaceId: WS, query: 'q', limit: 5 }, ADMIN)).results.map((r) => r.documentId);
    const defaults = await at({});
    expect(await at({ rrfK: SEARCH_RRF_K, trustWeights: TRUST_WEIGHTS })).toEqual(defaults);
    // Outdated sinks under the default weights; raising its weight lifts it.
    expect(defaults.indexOf('outdated')).toBeGreaterThan(0);
    const raised = await at({ trustWeights: { ...TRUST_WEIGHTS, outdated: 1.25 } });
    expect(raised.indexOf('outdated')).toBeLessThan(defaults.indexOf('outdated'));

    // Trust off, so only fusion orders: at k=60 a page third in both legs
    // (2/63) beats one first in only one (1/61); at k=1 it no longer does.
    const fused = async (rrfK: number) =>
      (
        await build(docs, [hit('plain', 0.9), hit('expired', 0.8), hit('inactive', 0.7)], false, [hit('outdated', 9), hit('verified', 8), hit('inactive', 7)], {
          rrfK,
        }).svc.search({ workspaceId: WS, query: 'q', limit: 3 }, ADMIN)
      ).results[0]!.documentId;
    expect(await fused(SEARCH_RRF_K)).toBe('inactive');
    expect(await fused(1)).toBe('plain');
  });
});

describe('SearchService relevance floor (#401)', () => {
  const docs = [plain, expired, inactive, outdated, verified];

  it('a hit weak in both legs no longer outranks one strong in either', async () => {
    // inactive is third in both legs: 2/63 beats 1/61 by rank fusion alone.
    const vector = [hit('plain', 0.5), hit('expired', 0.44), hit('inactive', 0.43)];
    const text = [hit('outdated', 9), hit('verified', 8), hit('inactive', 7)];
    const ids = async (knobs: Partial<SearchKnobs>) =>
      (await build(docs, vector, false, text, knobs).svc.search({ workspaceId: WS, query: 'q', limit: 5 }, ADMIN)).results.map((r) => r.documentId);
    expect((await ids({}))[0]).toBe('inactive');
    // Only plain is within 0.9 of the best cosine; inactive keeps its BM25
    // rank alone, below the leader of either leg.
    const floored = await ids({ minCosineShare: 0.9 });
    expect(floored.slice(0, 2).sort()).toEqual(['outdated', 'plain']);
    expect(floored).not.toContain('expired');
    expect(floored.indexOf('inactive')).toBeGreaterThan(1);
  });

  it('a search nothing answers returns fewer than its limit, and says how much the floor dropped', async () => {
    const vector = [hit('plain', 0.36), hit('expired', 0.35), hit('inactive', 0.34)];
    const { svc } = build(docs, vector, false, [], { minCosine: 0.4, minCosineShare: 0.9 });
    const res = await svc.search({ workspaceId: WS, query: 'off-topic', limit: 3, mode: 'semantic' }, ADMIN);
    expect(res.results).toEqual([]);
    // Told apart from a search whose legs found nothing.
    expect(vi.mocked(emitBacktest)).toHaveBeenLastCalledWith(expect.objectContaining({ vectorHits: 3, vectorFloored: 3, fusedHits: 0 }));

    const partial = build(docs, [hit('plain', 0.6), hit('expired', 0.45), hit('inactive', 0.3)], false, [], { minCosine: 0.4, minCosineShare: 0.7 });
    const some = await partial.svc.search({ workspaceId: WS, query: 'q', limit: 3, mode: 'semantic' }, ADMIN);
    expect(some.results.map((r) => r.documentId)).toEqual(['plain', 'expired']);
  });

  it('a keyword hit far below the BM25 leader is not fused (#416), and the replay agrees', async () => {
    // Prod, 2026-10-21: «Навигация и вкладки» reached the top 5 on two common
    // words, at about half the best BM25 score.
    const text = [hit('outdated', 7), hit('verified', 5.8), hit('inactive', 3.6)];
    const { svc } = build(docs, [hit('plain', 0.5)], false, text);
    let pool = null as SearchPool | null;
    const res = await svc.search({ workspaceId: WS, query: 'q', limit: 5 }, ADMIN, undefined, (p) => (pool = p));
    expect(res.results.map((r) => r.documentId).sort()).toEqual(['outdated', 'plain', 'verified']);
    expect(rankPool(pool!, { rrfK: SEARCH_RRF_K, minCosine: 0, minCosineShare: 0, communityPriorWeight: 0, communityPriorFloor: 0.5, trustWeights: TRUST_WEIGHTS })).toEqual(
      res.results.map((r) => r.documentId),
    );
  });

  it('measures both floors against a hit the search can return, not one PG then drops (#526)', async () => {
    // `hidden` is absent from PG for this reader; `archived` is put away;
    // `elsewhere` is outside the project filter. Each tops both legs, and
    // `plain` sits under both floors measured against any of them.
    const elsewhere = row('elsewhere', { projectId: 'q' });
    const vector = [hit('hidden', 0.95), hit('archived', 0.9), hit('elsewhere', 0.85), hit('plain', 0.6)];
    const text = [hit('hidden', 10), hit('archived', 9), hit('elsewhere', 8), hit('plain', 5)];
    const knobs = { minCosineShare: 0.9 };
    const { svc } = build([plain, archived, elsewhere], vector, false, text, knobs);
    for (const mode of ['semantic', 'keyword', 'hybrid'] as const) {
      const res = await svc.search({ workspaceId: WS, query: 'q', mode, filters: { projectIds: ['p'] } }, ADMIN);
      expect([mode, res.results.map((r) => r.documentId)]).toEqual([mode, ['plain']]);
    }

    // The replay floors the same pool: the pages the join returned, archive dropped.
    let pool = null as SearchPool | null;
    const res = await svc.search({ workspaceId: WS, query: 'q' }, ADMIN, undefined, (p) => (pool = p));
    expect(res.results.map((r) => r.documentId)).toEqual(['elsewhere', 'plain']);
    expect(rankPool(pool!, { rrfK: SEARCH_RRF_K, minCosine: 0, communityPriorWeight: 0, communityPriorFloor: 0.5, trustWeights: TRUST_WEIGHTS, ...knobs })).toEqual(
      res.results.map((r) => r.documentId),
    );
  });
});

describe('firstPerPage (#416)', () => {
  it("keeps each page's first, best-ranked chunk, in rank order", () => {
    const hits = [hit('a', 0.9), { ...hit('b', 0.8), chunkId: 'b1' }, { ...hit('a', 0.7), chunkId: 'a2' }, hit('c', 0.6)];
    expect(firstPerPage(hits).map((h) => [h.documentId, h.score])).toEqual([['a', 0.9], ['b', 0.8], ['c', 0.6]]);
  });
});

/** The community prior (#475, docs/features/63): a boost from the readable community tree, off by default. */
describe('communityPrior', () => {
  const c = (communityId: string, level: number, parentId: string | null, members: string[], score: number): PriorCommunity => ({
    communityId,
    level,
    parentId,
    members,
    score,
  });
  const tree = [
    c('top', 1, null, ['a', 'b', 'c'], 0.7),
    c('A', 0, 'top', ['a', 'b'], 0.8),
    c('B', 0, 'top', ['c'], 0.6),
    c('other', 0, null, ['d'], 0.9),
  ];

  it('is empty at weight 0, whatever the scores', () => {
    expect(communityPrior(tree, { communityPriorWeight: 0, communityPriorFloor: 0 }).size).toBe(0);
  });

  it('walks from the coarsest clearing level down its best children, deeper pages boosted more', () => {
    expect([...communityPrior(tree, { communityPriorWeight: 1, communityPriorFloor: 0.5 })].sort()).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 1.5],
    ]);
  });

  it('starts lower when no coarse community clears the floor, and boosts nothing when none does', () => {
    const weakTop = tree.map((x) => (x.communityId === 'top' ? { ...x, score: 0.3 } : x));
    expect([...communityPrior(weakTop, { communityPriorWeight: 1, communityPriorFloor: 0.5 })]).toEqual([['d', 2]]);
    expect(communityPrior(tree, { communityPriorWeight: 1, communityPriorFloor: 0.95 }).size).toBe(0);
  });
});

describe('SearchService community prior and placement (#475)', () => {
  const docs = [plain, row('member'), row('other')];
  const vector = [hit('plain', 0.9), hit('member', 0.8), hit('other', 0.7)];
  const stored = (members: string[]) => [
    { communityId: '1:x', level: 1, parentId: null, title: 'Payments', summary: '', members, builtAt: 0, score: 0.8 },
    { communityId: '0:x', level: 0, parentId: '1:x', title: 'Invoices', summary: '', members, builtAt: 0, score: 0.9 },
  ];
  const scored = (members: string[]) => ({ scored: vi.fn(async () => stored(members)) });
  const order = async (knobs: Partial<SearchKnobs>, communities = scored(['member'])) =>
    (await build(docs, vector, false, [], knobs, communities).svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, ADMIN)).results;

  it('ranks exactly as before at weight 0, communities or not', async () => {
    const none = (await build(docs, vector, false).svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, ADMIN)).results;
    const off = await order({});
    expect(off.map((r) => [r.documentId, r.score])).toEqual(none.map((r) => [r.documentId, r.score]));
  });

  it("boosts a matched community's pages without dropping anything", async () => {
    const on = await order({ communityPriorWeight: 1 });
    expect(on.map((r) => r.documentId)).toEqual(['member', 'plain', 'other']);
    expect(on[0]!.score).toBeCloseTo(0.8 * 2, 4);
  });

  it('doubles the candidate pool with the prior on, as trust ranking does', async () => {
    const { svc, graph } = build(docs, vector, false, [], { communityPriorWeight: 1 }, scored(['member']));
    await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 5 }, ADMIN);
    expect(graph.searchChunks.mock.calls[0]![2]).toBe(10);
  });

  it('tells each result its layer and its community path, coarsest first', async () => {
    const { svc, graph } = build(docs, vector, false, [], {}, scored(['member']));
    graph.entityKeysOf.mockResolvedValue(new Map([['member', ['op:get /invoices', 'service:billing']]]));
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, ADMIN);
    const member = res.results.find((r) => r.documentId === 'member')!;
    expect([member.layer, member.communityPath]).toEqual(['interface', ['Payments', 'Invoices']]);
    const other = res.results.find((r) => r.documentId === 'plain')!;
    expect(['layer' in other, 'communityPath' in other]).toEqual([false, false]);
  });

  it('gives no boost from a community, or its ancestor, holding a page the reader may not open', async () => {
    // The real CommunitiesService over the same PG: `secret` is no row the reader may read.
    const real = (members: string[]) => {
      const graph = { communities: vi.fn(async () => stored(members)) };
      const { prisma } = build(docs, vector, false);
      return new CommunitiesService(prisma as never, graph as never, { embed: vi.fn() } as never);
    };
    const withheld = await order({ communityPriorWeight: 1 }, real(['member', 'secret']));
    expect(withheld.map((r) => r.documentId)).toEqual(['plain', 'member', 'other']);
    expect(withheld.every((r) => !r.communityPath)).toBe(true);
    const open = await order({ communityPriorWeight: 1 }, real(['member']));
    expect(open[0]!.documentId).toBe('member');
  });

  it('ranks an asOf search the same with the prior on or off, and reads no community', async () => {
    const at = { at: NOW - day, knownAt: null, resolved: { kind: 'date', ref: 'x', at: new Date(NOW - day).toISOString(), knownAt: null } };
    const run = async (weight: number) => {
      const communities = scored(['member']);
      const { svc } = build(docs, vector, false, [], { communityPriorWeight: weight }, communities, async () => at);
      const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', asOf: 'x' }, ADMIN);
      return { ids: res.results.map((r) => [r.documentId, r.score, r.communityPath]), reads: communities.scored.mock.calls.length };
    };
    const [off, on] = [await run(0), await run(1)];
    expect(on).toEqual(off);
    expect(on.reads).toBe(0);
  });

  it('hands make tune scored communities, so rankPool replays the prior under any knobs', async () => {
    for (const knobs of [{}, { communityPriorWeight: 1 }, { communityPriorWeight: 0.3, communityPriorFloor: 0.85 }]) {
      const { svc } = build(docs, vector, true, [], knobs, scored(['member']));
      let pool = null as SearchPool | null;
      const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 3 }, ADMIN, undefined, (p) => (pool = p));
      expect(pool!.communities).toHaveLength(2);
      expect(
        rankPool(pool!, { rrfK: SEARCH_RRF_K, minCosine: 0, minCosineShare: 0, communityPriorWeight: 0, communityPriorFloor: 0.5, trustWeights: TRUST_WEIGHTS, ...knobs }),
      ).toEqual(res.results.map((r) => r.documentId));
    }
  });
});
