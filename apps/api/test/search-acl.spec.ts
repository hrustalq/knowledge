import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PermissionService } from '../src/permissions/permission.service.js';
import { SearchService } from '../src/search/search.service.js';
import { systemScope, type AccessScope } from '../src/permissions/access-scope.js';
import type { DocumentAclFilter } from '../src/common/document-acl.js';
import type { ChunkHit } from '../src/graph/graph.service.js';
import { matchesWhere, type WhereRow } from './prisma-where.js';

/**
 * Permission-aware search, #76 phase 3.
 *
 * What is pinned:
 * 1. **The stores get the caller's page list** (`documentFilterFor`): hidden
 *    pages for a member, reachable pages for a guest, nothing for an admin.
 * 2. **PG decides.** A store that ignored the filter — a lagging stamp, a list
 *    past ACL_DENY_LIST_MAX — still cannot put a hidden page in the results or
 *    in graph expansion, because the PG join applies the predicate itself.
 * 3. **The limit holds.** One refill round with a doubled fetch when the
 *    post-filter ate the head of a saturated leg, capped, never twice.
 * 4. **Deny by default.** If the scope cannot be turned into a filter, the
 *    search fails rather than answering unfiltered.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPEN2 = 'b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET_CHILD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ALICE = '44444444-4444-4444-8444-444444444444';
/** A restricted node with nothing under it. */
const EMPTY_NODE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const rows: WhereRow[] = [
  { id: OPEN, workspaceId: WS, projectId: PROJECT, path: `/${OPEN}/`, restrictedBy: [] },
  { id: OPEN2, workspaceId: WS, projectId: PROJECT, path: `/${OPEN2}/`, restrictedBy: [] },
  { id: SECRET, workspaceId: WS, projectId: PROJECT, path: `/${SECRET}/`, restrictedBy: [SECRET] },
  { id: SECRET_CHILD, workspaceId: WS, projectId: PROJECT, path: `/${SECRET}/${SECRET_CHILD}/`, restrictedBy: [SECRET] },
];

const base = { userId: ALICE, role: 'viewer' as const, bypass: false, guest: false, readOnly: false, groupIds: new Set<string>(), workspaceId: WS };
const ADMIN = systemScope(WS);
const MEMBER: AccessScope = { ...base, denied: new Set([SECRET]), granted: new Set() };
const GRANTEE: AccessScope = { ...base, denied: new Set(), granted: new Set([SECRET]) };
const GUEST: AccessScope = { ...base, role: 'guest', guest: true, denied: new Set([SECRET]), granted: new Set([OPEN]) };

/** The full PG row the search join selects, for a fixture row. */
const pgRow = (r: WhereRow) => ({
  ...r,
  title: `title ${r.id.slice(0, 4)}`,
  category: 'other',
  defaultBranch: 'main',
  verifiedAt: null,
  verifiedRevisionId: null,
  verificationExpiresAt: null,
  verificationFlag: null,
  ownerId: null,
  lastActivityAt: new Date(),
  archivedAt: null,
  branches: [],
});

function prismaOver(fixtures: WhereRow[]) {
  return {
    document: {
      findMany: vi.fn(async ({ where }: { where: Prisma.DocumentWhereInput }) =>
        fixtures.filter((r) => matchesWhere(where, r)).map(pgRow),
      ),
    },
  };
}

const hit = (documentId: string, score: number): ChunkHit => ({
  chunkId: `${documentId}:${score}`,
  documentId,
  revisionId: `${documentId}-head`,
  text: `text of ${documentId}`,
  headingPath: [],
  score,
});

function build(opts: {
  hits: ChunkHit[];
  denyListMax?: number;
  maxFetch?: number;
  relations?: { edges: Array<{ type: string; documentId: string; targetKey: string; extractor: string; confidence: number }> };
}) {
  const prisma = prismaOver(rows);
  const env: Record<string, number> = {
    ACL_DENY_LIST_MAX: opts.denyListMax ?? 5000,
    SEARCH_ACL_OVERFETCH: 5,
    SEARCH_ACL_MAX_FETCH: opts.maxFetch ?? 500,
  };
  const config = { get: vi.fn((key: string) => env[key]) };
  const permissions = new PermissionService(prisma as never, {} as never, {} as never, config as never);
  // A store that ignores the filter outright: whatever PG says is the answer.
  const graph = {
    searchChunks: vi.fn(async (_ws: string, _e: number[], k: number, _acl: DocumentAclFilter) => opts.hits.slice(0, k)),
    getDocumentIdsByTags: vi.fn(async () => new Set<string>()),
    getWorkspaceRelationGraph: vi.fn(async (_ws: string, _acl: DocumentAclFilter) => ({
      edges: opts.relations?.edges ?? [],
      documents: {},
      entities: {},
    })),
  };
  const svc = new SearchService(
    prisma as never,
    graph as never,
    { embed: vi.fn(async () => [1, 0]) } as never,
    { enabled: false, search: vi.fn(async () => []) } as never,
    { openIssueCounts: vi.fn(async () => new Map<string, number>()) } as never,
    {
      effective: vi.fn(async () => ({ reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40, trustRanking: false, minCosine: 0, minCosineShare: 0 })),
    } as never,
    permissions,
    config as never,
    // No asOf: every search here reads the live projection (#81).
    { resolve: async () => undefined } as never,
  );
  return { svc, graph, permissions, prisma };
}

describe('PermissionService.documentFilterFor', () => {
  const { permissions } = build({ hits: [] });

  it('hides nothing from an admin or from a member nothing is restricted from', async () => {
    expect(await permissions.documentFilterFor(ADMIN)).toEqual({ kind: 'all' });
    expect(await permissions.documentFilterFor(GRANTEE)).toEqual({ kind: 'all' });
  });

  it("lists a member's hidden pages — the restricted node and its whole subtree", async () => {
    const acl = await permissions.documentFilterFor(MEMBER);
    expect(acl).toMatchObject({ kind: 'deny', nodeIds: [SECRET], pushdown: true });
    expect([...(acl as { documentIds: Set<string> }).documentIds].sort()).toEqual([SECRET, SECRET_CHILD].sort());
  });

  it('treats a restricted node with nothing under it as hiding nothing', async () => {
    expect(await permissions.documentFilterFor({ ...MEMBER, denied: new Set([EMPTY_NODE]) })).toEqual({ kind: 'all' });
  });

  it("lists a guest's reachable pages, and none when they hold no grant", async () => {
    const acl = await permissions.documentFilterFor(GUEST);
    expect(acl).toMatchObject({ kind: 'allow', pushdown: true });
    expect([...(acl as { documentIds: Set<string> }).documentIds]).toEqual([OPEN]);
    const none = await permissions.documentFilterFor({ ...GUEST, granted: new Set() });
    expect([...(none as { documentIds: Set<string> }).documentIds]).toEqual([]);
  });

  it('stops pushing the list down past ACL_DENY_LIST_MAX', async () => {
    const { permissions: tight } = build({ hits: [], denyListMax: 1 });
    expect(await tight.documentFilterFor(MEMBER)).toMatchObject({ kind: 'deny', pushdown: false });
  });
});

describe('SearchService with an AccessScope', () => {
  const ranked = [hit(SECRET, 0.9), hit(SECRET_CHILD, 0.85), hit(OPEN, 0.8), hit(OPEN2, 0.7)];

  it('never returns a hidden page, even from a store that ignored the filter', async () => {
    const { svc, graph } = build({ hits: ranked });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 10 }, MEMBER);
    expect(res.results.map((r) => r.documentId)).toEqual([OPEN, OPEN2]);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    // …and the store was asked with the member's hidden pages.
    const acl = graph.searchChunks.mock.calls[0]![3];
    expect(acl).toMatchObject({ kind: 'deny', pushdown: true });
  });

  it('shows a guest only what was granted, a grantee and an admin everything', async () => {
    const guest = await build({ hits: ranked }).svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, GUEST);
    expect(guest.results.map((r) => r.documentId)).toEqual([OPEN]);

    const grantee = await build({ hits: ranked }).svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, GRANTEE);
    expect(grantee.results).toHaveLength(4);

    const { svc, graph } = build({ hits: ranked });
    const admin = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, ADMIN);
    expect(admin.results).toHaveLength(4);
    expect(graph.searchChunks.mock.calls[0]![3]).toEqual({ kind: 'all' });
  });

  it('refills once with a doubled fetch when the post-filter ate the head of a full leg', async () => {
    const { svc, graph } = build({ hits: ranked });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 2 }, MEMBER);
    expect(graph.searchChunks.mock.calls.map((c) => c[2])).toEqual([2, 4]);
    expect(res.results.map((r) => r.documentId)).toEqual([OPEN, OPEN2]);
  });

  it('caps the refill at SEARCH_ACL_MAX_FETCH and never runs a second one', async () => {
    const secrets = Array.from({ length: 10 }, (_, i) => hit(i % 2 ? SECRET : SECRET_CHILD, 1 - i / 100));
    const { svc, graph } = build({ hits: [...secrets, hit(OPEN, 0.1)], maxFetch: 3 });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 2 }, MEMBER);
    expect(graph.searchChunks.mock.calls.map((c) => c[2])).toEqual([2, 3]);
    expect(res.results).toEqual([]);
  });

  it('over-fetches when the hidden list is too long to push into the stores', async () => {
    const { svc, graph } = build({ hits: ranked, denyListMax: 0 });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 2 }, MEMBER);
    expect(graph.searchChunks.mock.calls[0]![2]).toBe(10); // k × SEARCH_ACL_OVERFETCH
    expect(graph.searchChunks.mock.calls[0]![3]).toMatchObject({ kind: 'deny', pushdown: false });
    expect(res.results.map((r) => r.documentId)).toEqual([OPEN, OPEN2]);
  });

  it('keeps hidden pages out of graph expansion, whatever the graph returned', async () => {
    const edge = (documentId: string) => ({ type: 'DEPENDS_ON', documentId, targetKey: 'service:billing', extractor: 'explicit', confidence: 1 });
    const { svc, graph } = build({ hits: [hit(OPEN, 0.9)], relations: { edges: [edge(OPEN), edge(SECRET), edge(OPEN2)] } });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'hybrid', expandGraph: { depth: 1 } }, MEMBER);
    expect(res.related?.map((r) => r.documentId)).toEqual([OPEN2]);
    expect(graph.getWorkspaceRelationGraph.mock.calls[0]![1]).toMatchObject({ kind: 'deny' });
  });

  it('drops a page PG no longer has for every reader, an admin included', async () => {
    // Chunks and edges can outlive a page deleted from PG. For a reader who
    // hides nothing they used to come back as "(unknown)" and outrank real
    // answers, so known-item recall depended on whether the caller had any
    // restriction in their way.
    const GONE = 'f0f0f0f0-ffff-4fff-8fff-ffffffffffff';
    const edge = (documentId: string) => ({ type: 'DEPENDS_ON', documentId, targetKey: 'service:billing', extractor: 'explicit', confidence: 1 });
    for (const scope of [ADMIN, GRANTEE, MEMBER]) {
      const { svc } = build({ hits: [hit(GONE, 0.99), hit(OPEN, 0.9)], relations: { edges: [edge(OPEN), edge(GONE), edge(OPEN2)] } });
      const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'hybrid', expandGraph: { depth: 1 } }, scope);
      expect(res.results.map((r) => r.documentId)).toEqual([OPEN]);
      expect(res.related?.map((r) => r.documentId)).toEqual([OPEN2]);
    }
  });

  it('fails rather than answering unfiltered when the scope cannot be read', async () => {
    const { svc, prisma } = build({ hits: ranked });
    prisma.document.findMany.mockRejectedValueOnce(new Error('pg down'));
    await expect(svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' }, MEMBER)).rejects.toThrow('pg down');
  });
});

describe("SearchService with groupBy: 'page' (#443)", () => {
  const chunks = (documentId: string, n: number, top: number) =>
    Array.from({ length: n }, (_, i) => hit(documentId, top - i * 0.001));

  it("lists each page once, by its best chunk, and only then counts the limit", async () => {
    const hits = [...chunks(OPEN, 3, 0.9), hit(OPEN2, 0.8), hit(SECRET, 0.7), hit(SECRET_CHILD, 0.6)];
    const res = await build({ hits }).svc.search({ workspaceId: WS, query: 'text', mode: 'semantic', limit: 3, groupBy: 'page' }, ADMIN);
    expect(res.results.map((r) => r.documentId)).toEqual([OPEN, OPEN2, SECRET]);
    expect(res.results[0]!.chunkId).toBe(hits[0]!.chunkId);
    expect(res.results[0]!.snippetParts).toEqual([{ text: 'text', hit: true }, { text: ` of ${OPEN}`, hit: false }]);
  });

  it('refills once when the pool names fewer pages than the limit', async () => {
    // limit 2 fetches 6 chunks, all of one page; the doubled pull reaches the second.
    const { svc, graph } = build({ hits: [...chunks(OPEN, 6, 0.9), hit(OPEN2, 0.5)] });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 2, groupBy: 'page' }, ADMIN);
    expect(res.results.map((r) => r.documentId)).toEqual([OPEN, OPEN2]);
    expect(graph.searchChunks.mock.calls.map((c) => c[2])).toEqual([6, 12]);
  });

  it('leaves a chunk-level search as it was', async () => {
    const res = await build({ hits: chunks(OPEN, 3, 0.9) }).svc.search({ workspaceId: WS, query: 'text', mode: 'semantic', limit: 3 }, ADMIN);
    expect(res.results).toHaveLength(3);
    expect(res.results.some((r) => 'snippetParts' in r)).toBe(false);
  });
});
