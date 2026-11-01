import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchService } from '../src/search/search.service.js';
import { OpenSearchFulltextProvider } from '../src/fulltext/opensearch.provider.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { UNFILTERED } from '../src/common/document-acl.js';
import type { TemporalPoint } from '../src/graph/temporal.js';

/**
 * #81 phase 3 — a search as of a point answers from the text each page held
 * then. Pinned on the issue's example: v1 says "uses Postgres 14", v2 "uses
 * Postgres 16"; as of v1 the v1 chunk comes back, marked superseded, and a
 * search of now returns only v2.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const V1_AT = Date.parse('2026-01-01T00:00:00Z');
const V2_AT = Date.parse('2026-02-01T00:00:00Z');

const chunks = [
  { chunkId: 'r1:0', documentId: DOC, revisionId: 'r1', text: 'The billing service uses Postgres 14', headingPath: [], embedding: [1, 0], live: false, validFrom: V1_AT, validTo: V2_AT },
  { chunkId: 'r2:0', documentId: DOC, revisionId: 'r2', text: 'The billing service uses Postgres 16', headingPath: [], embedding: [1, 0], live: true, validFrom: V2_AT, validTo: null },
];

const point = (at: number, ref = 'tag:v1'): TemporalPoint => ({
  at,
  knownAt: null,
  resolved: { kind: 'tag', ref, at: new Date(at).toISOString(), knownAt: null },
});

function build(at: TemporalPoint | undefined) {
  const prisma = {
    connectorLink: { findMany: vi.fn(async () => []) }, // no source-backed pages (#674)
    document: {
      findMany: vi.fn(async () => [
        {
          id: DOC,
          title: 'Billing',
          category: 'other',
          projectId: null,
          defaultBranch: 'main',
          verifiedAt: null,
          verifiedRevisionId: null,
          verificationExpiresAt: null,
          verificationFlag: null,
          ownerId: null,
          lastActivityAt: new Date(),
          archivedAt: null,
          branches: [{ name: 'main', headRevisionId: 'r2' }],
        },
      ]),
      // loadRevisionStamps: validity comes from PG, not from the store.
      findUnique: vi.fn(async () => ({
        defaultBranch: 'main',
        branches: [{ id: 'b-main', name: 'main' }],
        revisions: [
          { id: 'r1', branchId: 'b-main', finalizedAt: new Date(V1_AT) },
          { id: 'r2', branchId: 'b-main', finalizedAt: new Date(V2_AT) },
        ],
      })),
    },
  };
  // A store that honours exactly the two predicates GraphService builds.
  const graph = {
    entityKeysOf: vi.fn(async () => new Map<string, string[]>()),
    searchChunks: vi.fn(async (_ws: string, _e: number[], k: number, _acl: unknown, p?: TemporalPoint) =>
      chunks
        .filter((c) => (p ? c.validFrom <= p.at && (c.validTo === null || c.validTo > p.at) : c.live))
        .map((c) => ({ ...c, score: 0.9 }))
        .slice(0, k),
    ),
    getDocumentIdsByTags: vi.fn(async () => new Set([DOC])),
    getWorkspaceRelationGraph: vi.fn(async () => ({ edges: [], documents: {}, entities: {} })),
  };
  const fulltext = { enabled: true, search: vi.fn(async () => []) };
  const svc = new SearchService(
    prisma as never,
    graph as never,
    { embed: vi.fn(async () => [1, 0]) } as never,
    fulltext as never,
    { openIssueCounts: vi.fn(async () => new Map()) } as never,
    { effective: vi.fn(async () => ({ reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40, trustRanking: false, minCosine: 0, minCosineShare: 0 })) } as never,
    { documentFilterFor: vi.fn(async () => UNFILTERED) } as never,
    { get: vi.fn(() => 1000) } as never,
    { resolve: vi.fn(async () => at) } as never,
    // No analytics, no communities built (#475): no prior, no communityPath.
    { search: () => undefined } as never,
    { scored: async () => [] } as never,
  );
  return { svc, graph, fulltext };
}

describe('SearchService as of a point (#81)', () => {
  it('as of v1 returns the v1 text, dated and marked superseded', async () => {
    const at = point(Date.parse('2026-01-15T00:00:00Z'));
    const { svc, graph, fulltext } = build(at);
    const res = await svc.search(
      { workspaceId: WS, query: 'postgres version', asOf: 'tag:v1', expandGraph: { depth: 1 }, filters: { tags: ['billing'] } },
      systemScope(WS),
    );
    expect(res.results.map((r) => r.snippet)).toEqual(['The billing service uses Postgres 14']);
    expect(res.results[0]).toMatchObject({ validFrom: new Date(V1_AT).toISOString(), validTo: new Date(V2_AT).toISOString() });
    expect(res.resolvedAsOf).toEqual(at.resolved);
    // Every leg got the same point: vectors, BM25, the tag filter and the graph walk.
    expect(graph.searchChunks.mock.calls[0][4]).toBe(at);
    expect((fulltext.search.mock.calls[0] as unknown[])[4]).toBe(at);
    expect((graph.getDocumentIdsByTags.mock.calls[0] as unknown[])[3]).toBe(at);
    expect((graph.getWorkspaceRelationGraph.mock.calls[0] as unknown[])[2]).toBe(at);
  });

  it('without asOf returns only the current text, with no validity fields and no echo', async () => {
    const { svc } = build(undefined);
    const res = await svc.search({ workspaceId: WS, query: 'postgres version' }, systemScope(WS));
    expect(res.results.map((r) => r.snippet)).toEqual(['The billing service uses Postgres 16']);
    expect(res.results[0].validTo).toBeUndefined();
    expect(res.resolvedAsOf).toBeUndefined();
  });
});

describe('OpenSearch as of a point (#81)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function provider() {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        bodies.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
        return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
      }),
    );
    const config = { get: vi.fn((k: string) => ({ OPENSEARCH_URL: 'http://os:9200', OPENSEARCH_INDEX: 'chunks' })[k]) };
    return { os: new OpenSearchFulltextProvider(config as never), bodies };
  }

  it('swaps the live filter for the interval, bound as values', async () => {
    const { os, bodies } = provider();
    await os.search(WS, 'postgres', 10, UNFILTERED, point(1234));
    const q = bodies.find((b) => b.url.endsWith('/_search'))!.body.query as { bool: { filter: unknown[]; must_not: unknown[] } };
    expect(q.bool.must_not).toEqual([]);
    expect(q.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { workspaceId: WS } },
        { term: { lineage: 'default' } },
        { range: { validFrom: { lte: 1234 } } },
      ]),
    );
  });

  it('a search of now keeps the live filter', async () => {
    const { os, bodies } = provider();
    await os.search(WS, 'postgres', 10, UNFILTERED);
    const q = bodies.find((b) => b.url.endsWith('/_search'))!.body.query as { bool: { must_not: unknown[] } };
    expect(q.bool.must_not).toEqual([{ term: { live: false } }]);
  });

  it('stamps one revision at a time, scoped to the page', async () => {
    const { os, bodies } = provider();
    await os.stampRevisions(WS, DOC, [{ revisionId: 'r1', validFrom: 1, validTo: 2, lineage: 'default' }]);
    const stamp = bodies.find((b) => b.url.includes('_update_by_query'))!.body as { query: unknown; script: { params: unknown } };
    expect(JSON.stringify(stamp.query)).toContain(DOC);
    expect(JSON.stringify(stamp.query)).toContain('"revisionId":"r1"');
    expect(stamp.script.params).toEqual({ validFrom: 1, validTo: 2, lineage: 'default' });
  });
});
