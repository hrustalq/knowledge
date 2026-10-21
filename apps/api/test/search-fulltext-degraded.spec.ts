import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchService } from '../src/search/search.service.js';
import { StaleSweeper } from '../src/ingestion/stale.sweeper.js';
import { OpenSearchFulltextProvider } from '../src/fulltext/opensearch.provider.js';
import { UNFILTERED } from '../src/common/document-acl.js';
import { systemScope } from '../src/permissions/access-scope.js';

/**
 * #173: the BM25 leg is optional. When OpenSearch fails or hangs, a search
 * answers from vectors alone and says so; with no BM25 layer nothing changes.
 * Revisions whose BM25 write failed are re-mirrored by the stale sweeper.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const ADMIN = systemScope(WS);

function hit(documentId: string, score: number) {
  return { documentId, revisionId: 'head', chunkId: `c-${documentId}`, text: `text of ${documentId}`, headingPath: [], score };
}

function doc(id: string) {
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
    lastActivityAt: new Date(),
    archivedAt: null,
    branches: [{ name: 'main', headRevisionId: 'head' }],
  };
}

function build(fulltext: { enabled: boolean; search: (...a: unknown[]) => Promise<unknown> }) {
  const docs = [doc('vec'), doc('kw')];
  const prisma = {
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => docs.filter((d) => where.id.in.includes(d.id))),
    },
  };
  const graph = {
    searchChunks: vi.fn(async () => [hit('vec', 0.9)]),
    getDocumentIdsByTags: vi.fn(async () => new Set<string>()),
    getWorkspaceRelationGraph: vi.fn(async () => ({ edges: [], entities: {}, documents: {} })),
  };
  const embeddings = { embed: vi.fn(async () => [0.1, 0.2]) };
  const provenance = { openIssueCounts: vi.fn(async () => new Map<string, number>()) };
  const policy = {
    effective: vi.fn(async () => ({ reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40, trustRanking: false, minCosine: 0, minCosineShare: 0 })),
  };
  const permissions = { documentFilterFor: vi.fn(async () => ({ kind: 'all' as const })) };
  const config = {
    get: vi.fn((key: string) => ({ SEARCH_ACL_OVERFETCH: 5, SEARCH_ACL_MAX_FETCH: 500, FULLTEXT_TIMEOUT_MS: 50 })[key]),
  };
  const svc = new SearchService(
    prisma as never,
    graph as never,
    embeddings as never,
    fulltext as never,
    provenance as never,
    policy as never,
    permissions as never,
    config as never,
    // No asOf: every search here reads the live projection (#81).
    { resolve: async () => undefined } as never,
  );
  const warn = vi.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
  return { svc, graph, warn };
}

describe('SearchService with an unreachable BM25 index (#173)', () => {
  it('answers a hybrid search from vectors alone and names the skipped leg', async () => {
    const { svc } = build({ enabled: true, search: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) });
    const res = await svc.search({ workspaceId: WS, query: 'q' }, ADMIN);
    expect(res.results.map((r) => r.documentId)).toEqual(['vec']);
    expect(res.degraded).toEqual(['fulltext']);
  });

  it('does not let a hanging index hold the request past FULLTEXT_TIMEOUT_MS', async () => {
    const { svc } = build({ enabled: true, search: vi.fn(() => new Promise(() => {})) });
    const started = Date.now();
    const res = await svc.search({ workspaceId: WS, query: 'q' }, ADMIN);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.results.map((r) => r.documentId)).toEqual(['vec']);
    expect(res.degraded).toEqual(['fulltext']);
  });

  it('runs the vector leg a keyword search skipped, rather than answering nothing', async () => {
    const { svc, graph } = build({ enabled: true, search: vi.fn(async () => Promise.reject(new Error('down'))) });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'keyword' }, ADMIN);
    expect(graph.searchChunks).toHaveBeenCalledTimes(1);
    expect(res.results.map((r) => r.documentId)).toEqual(['vec']);
    expect(res.degraded).toEqual(['fulltext']);
  });

  it('warns once per outage, not once per search', async () => {
    const { svc, warn } = build({ enabled: true, search: vi.fn(async () => Promise.reject(new Error('down'))) });
    await svc.search({ workspaceId: WS, query: 'a' }, ADMIN);
    await svc.search({ workspaceId: WS, query: 'b' }, ADMIN);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a healthy hybrid response without `degraded`', async () => {
    const { svc } = build({ enabled: true, search: vi.fn(async () => [hit('kw', 3)]) });
    const res = await svc.search({ workspaceId: WS, query: 'q' }, ADMIN);
    expect(res.results.map((r) => r.documentId).sort()).toEqual(['kw', 'vec']);
    expect(res).not.toHaveProperty('degraded');
  });

  it('reports the same raw cosine whichever legs answered (#403)', async () => {
    const hybrid = build({ enabled: true, search: vi.fn(async () => [hit('vec', 3), hit('kw', 2)]) });
    const degraded = build({ enabled: true, search: vi.fn(async () => Promise.reject(new Error('down'))) });
    const vectorOnly = build({ enabled: false, search: vi.fn(async () => []) });
    const top = async (b: ReturnType<typeof build>) =>
      (await b.svc.search({ workspaceId: WS, query: 'q' }, ADMIN)).results.map((r) => [r.documentId, r.vectorScore]);
    // Fused, `vec` scores ~0.033; its cosine stays 0.9. BM25-only `kw` has none.
    expect(await top(hybrid)).toEqual([['vec', 0.9], ['kw', undefined]]);
    expect(await top(degraded)).toEqual([['vec', 0.9]]);
    expect(await top(vectorOnly)).toEqual([['vec', 0.9]]);
  });

  it('is unchanged with FULLTEXT_PROVIDER=none', async () => {
    const search = vi.fn(async () => []);
    const { svc } = build({ enabled: false, search });
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'keyword' }, ADMIN);
    expect(search).not.toHaveBeenCalled();
    expect(res).toEqual({ results: [expect.objectContaining({ documentId: 'vec' })] });
  });
});

describe('StaleSweeper.repairFulltext (#173)', () => {
  const stampA = new Date('2026-10-15T10:00:00Z');
  const stampB = new Date('2026-10-15T10:01:00Z');
  const document = {
    workspaceId: WS,
    restrictedBy: ['r1'],
    defaultBranch: 'main',
    branches: [{ name: 'main', headRevisionId: 'head' }],
  };

  function sweeper(fulltext: Record<string, unknown>) {
    const prisma = {
      documentRevision: {
        findMany: vi.fn(async () => [
          { id: 'head', documentId: 'd1', fulltextStaleAt: stampA, document },
          { id: 'old', documentId: 'd1', fulltextStaleAt: stampB, document },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      // #81: the re-mirrored revision is stamped again from PG.
      document: {
        findUnique: vi.fn(async () => ({
          defaultBranch: 'main',
          branches: [{ id: 'b-main', name: 'main' }],
          revisions: [
            { id: 'old', branchId: 'b-main', finalizedAt: new Date(1000) },
            { id: 'head', branchId: 'b-main', finalizedAt: new Date(2000) },
          ],
        })),
      },
    };
    const graph = {
      getRevisionChunkTexts: vi.fn(async (_ws: string, rev: string) => [
        { chunkId: `${rev}:0`, documentId: 'd1', index: 0, text: 'body', headingPath: [] },
      ]),
    };
    const svc = new StaleSweeper(prisma as never, {} as never, {} as never, graph as never, fulltext as never);
    vi.spyOn((svc as unknown as { logger: { warn: () => void; log: () => void } }).logger, 'warn').mockImplementation(() => {});
    vi.spyOn((svc as unknown as { logger: { warn: () => void; log: () => void } }).logger, 'log').mockImplementation(() => {});
    return { svc, prisma };
  }

  it('re-mirrors from the graph, flips the head live, and clears only the stamp it read', async () => {
    const fulltext = {
      enabled: true,
      indexRevisionChunks: vi.fn(async () => {}),
      setLiveRevision: vi.fn(async () => {}),
      stampRevisions: vi.fn(async () => {}),
    };
    const { svc, prisma } = sweeper(fulltext);
    expect(await svc.repairFulltext()).toBe(2);
    // Re-mirrored rows are written unstamped; each gets its own interval back (#81).
    expect(fulltext.stampRevisions).toHaveBeenCalledWith(WS, 'd1', [{ revisionId: 'head', validFrom: 2000, validTo: null, lineage: 'default' }]);
    expect(fulltext.stampRevisions).toHaveBeenCalledWith(WS, 'd1', [{ revisionId: 'old', validFrom: 1000, validTo: 2000, lineage: 'default' }]);

    expect(fulltext.indexRevisionChunks).toHaveBeenCalledWith(
      WS,
      'head',
      [{ chunkId: 'head:0', documentId: 'd1', revisionId: 'head', index: 0, text: 'body', headingPath: [] }],
      { live: true, aclNodes: ['r1'] },
    );
    expect(fulltext.indexRevisionChunks).toHaveBeenCalledWith(WS, 'old', expect.any(Array), { live: false, aclNodes: ['r1'] });
    expect(fulltext.setLiveRevision).toHaveBeenCalledTimes(1);
    expect(fulltext.setLiveRevision).toHaveBeenCalledWith(WS, 'd1', 'head');
    expect(prisma.documentRevision.updateMany).toHaveBeenCalledWith({
      where: { id: 'head', fulltextStaleAt: stampA },
      data: { fulltextStaleAt: null },
    });
  });

  it('stops at the first failure and leaves the stamps in place', async () => {
    const fulltext = {
      enabled: true,
      indexRevisionChunks: vi.fn(async () => Promise.reject(new Error('still down'))),
      setLiveRevision: vi.fn(async () => {}),
    };
    const { svc, prisma } = sweeper(fulltext);
    expect(await svc.repairFulltext()).toBe(0);
    expect(fulltext.indexRevisionChunks).toHaveBeenCalledTimes(1);
    expect(prisma.documentRevision.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing without a BM25 layer', async () => {
    const { svc, prisma } = sweeper({ enabled: false });
    expect(await svc.repairFulltext()).toBe(0);
    expect(prisma.documentRevision.findMany).not.toHaveBeenCalled();
  });
});

describe('OpenSearch provider after a network error (#330)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries the index setup instead of caching the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async () => new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const os = new OpenSearchFulltextProvider('http://os:9200', 'chunks');

    await expect(os.search(WS, 'q', 10, UNFILTERED)).rejects.toThrow('fetch failed');
    await expect(os.search(WS, 'q', 10, UNFILTERED)).resolves.toEqual([]);

    const puts = fetchMock.mock.calls.filter(([url, init]) => url === 'http://os:9200/chunks' && init?.method === 'PUT');
    expect(puts).toHaveLength(2);
  });
});
