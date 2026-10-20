import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { cosine, GraphService } from '../src/graph/graph.service.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';
import { UNFILTERED, type DocumentAclFilter } from '../src/common/document-acl.js';

/**
 * #304: the vector leg is answered by ArcadeDB's HNSW index, with every
 * restriction applied INSIDE the nearest-neighbour search.
 *
 * The fake below plays ArcadeDB faithfully on one point: `vector.neighbors`
 * only honours the predicates in its `filter` subquery. It ranks exactly (so
 * recall is not what is under test) and throws on a predicate it does not
 * know, so a clause that drifts cannot be silently ignored. A read that left
 * the workspace, live or ACL predicate out of the filter would get the
 * forbidden chunk back in the top-k — and with k = 1, nothing after it.
 *
 * The same behaviour against a real ArcadeDB 26.10.2 is
 * `vector-index.e2e-spec.ts` (needs a throwaway server).
 */

type Row = Record<string, unknown> & { chunkId: string; workspaceId: string; documentId: string; embedding?: number[] };

/** The predicates `GraphService` builds, each with how ArcadeDB evaluates it. */
const PREDICATES: Array<[string, (r: Row, p: Record<string, unknown>) => boolean]> = [
  ['workspaceId = :workspaceId', (r, p) => r.workspaceId === p.workspaceId],
  ['(live IS NULL OR live = true)', (r) => r.live !== false],
  ['NOT (documentId IN :aclDocs)', (r, p) => !(p.aclDocs as string[]).includes(r.documentId)],
  ['documentId IN :aclDocs', (r, p) => (p.aclDocs as string[]).includes(r.documentId)],
  ['(aclNodes IS NULL OR NOT (aclNodes CONTAINSANY :aclNodeIds))', (r, p) => !((r.aclNodes as string[] | undefined) ?? []).some((n) => (p.aclNodeIds as string[]).includes(n))],
  ['revisionId IN :revisionIds', (r, p) => (p.revisionIds as string[]).includes(r.revisionId as string)],
];

function matcher(where: string): (r: Row, p: Record<string, unknown>) => boolean {
  let rest = where;
  const used: Array<(r: Row, p: Record<string, unknown>) => boolean> = [];
  for (const [sql, fn] of PREDICATES) {
    if (rest.includes(sql)) {
      rest = rest.replace(sql, '');
      used.push(fn);
    }
  }
  if (rest.replace(/\bAND\b/g, '').trim()) throw new Error(`fake ArcadeDB: unknown predicate in "${where}" → "${rest}"`);
  return (r, p) => used.every((fn) => fn(r, p));
}

function fakeArcade(rows: Row[], opts: { indexDim: number | null; rejectIndex?: boolean }) {
  const state = { indexDim: opts.indexDim, ddl: [] as string[], efSearch: [] as number[], scans: 0 };
  rows.forEach((r, i) => (r['@rid'] = `#1:${i}`));
  const query = vi.fn(async (_lang: string, sql: string, params: Record<string, unknown> = {}) => {
    if (sql === "SELECT indexes FROM schema:types WHERE name = 'Chunk'") {
      return [{ indexes: state.indexDim === null ? [] : [{ name: 'Chunk[embedding]', dimensions: state.indexDim }] }];
    }
    if (sql === 'select from schema:types') {
      return ['Document', 'DocumentRevision', 'Chunk', 'Entity', 'HAS_REVISION', 'HAS_CHUNK'].map((name) => ({ name }));
    }
    const ann = /vector\.neighbors\('Chunk\[embedding\]', :queryVector, :k, \{ efSearch: (\d+), filter: \(SELECT @rid FROM Chunk WHERE (.+)\) \}\)\)\) WHERE workspaceId = :workspaceId$/.exec(sql);
    if (ann) {
      state.efSearch.push(Number(ann[1]));
      const q = params.queryVector as number[];
      if (q.length !== state.indexDim) throw new Error(`Query vector dimension ${q.length} does not match index dimension ${state.indexDim}`);
      const keep = matcher(ann[2]);
      // The index holds only vectors of its own dimension.
      return rows
        .filter((r) => r.embedding?.length === state.indexDim && keep(r, params))
        .map((r) => ({ ...r, distance: 1 - cosine(q, r.embedding!) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, params.k as number);
    }
    const rid = /^SELECT @rid AS rid FROM Chunk WHERE (.+)$/.exec(sql);
    if (rid) {
      const keep = matcher(rid[1]);
      return rows.filter((r) => keep(r, params)).map((r) => ({ rid: r['@rid'] }));
    }
    const byRid = /^SELECT .+ FROM \[(.+)\] WHERE (.+)$/.exec(sql);
    if (byRid) {
      const wanted = new Set(byRid[1].split(', '));
      const keep = matcher(byRid[2]);
      return rows.filter((r) => wanted.has(r['@rid'] as string) && keep(r, params));
    }
    const scan = /^SELECT .+ FROM Chunk WHERE (.+) LIMIT (\d+)$/.exec(sql);
    if (scan) {
      state.scans++;
      const keep = matcher(scan[1]);
      // No ORDER BY: storage order, which is what made the old cap arbitrary.
      return rows.filter((r) => keep(r, params)).slice(0, Number(scan[2]));
    }
    throw new Error(`fake ArcadeDB: unexpected query ${sql}`);
  });
  const command = vi.fn(async (_lang: string, sql: string) => {
    state.ddl.push(sql);
    const create = /LSM_VECTOR METADATA \{ dimensions: (\d+)/.exec(sql);
    if (create) {
      if (opts.rejectIndex) throw new Error('ArcadeDB command failed with 400: unknown index type');
      state.indexDim = Number(create[1]);
    }
    if (sql.startsWith('DROP INDEX')) state.indexDim = null;
    return [];
  });
  const graph = new GraphService({ query, command } as unknown as ArcadeClient, {} as EntityAliasService);
  return { graph, state, query };
}

const WS = 'ws-1';
const query = [1, 0, 0];
/** Spread around the sphere and away from the query. */
const far = (i: number) => [-0.2, Math.cos(i), Math.sin(i)];
const chunk = (chunkId: string, extra: Partial<Row> = {}): Row => ({
  chunkId,
  workspaceId: WS,
  documentId: `doc-${chunkId}`,
  revisionId: `rev-${chunkId}`,
  live: true,
  text: chunkId,
  headingPath: [],
  embedding: far(chunkId.length + chunkId.charCodeAt(chunkId.length - 1)),
  ...extra,
});

/** 6,000 eligible chunks, then the answer, then three exact matches nobody may see. */
function corpus(): Row[] {
  return [
    ...Array.from({ length: 6000 }, (_, i) => chunk(`c${i}`, { embedding: far(i), documentId: `doc-${i % 500}`, revisionId: `rev-${i % 500}` })),
    chunk('planted', { embedding: [0.99, 0.1, 0] }),
    chunk('other-ws', { workspaceId: 'ws-2', embedding: query }),
    chunk('history', { live: false, embedding: query }),
    chunk('secret', { documentId: 'doc-secret', aclNodes: ['node-secret'], embedding: query }),
  ];
}

const deny = (pushdown: boolean): DocumentAclFilter => ({ kind: 'deny', documentIds: new Set(['doc-secret']), nodeIds: ['node-secret'], pushdown });

afterEach(() => vi.restoreAllMocks());

describe('searchChunks through the vector index (#304)', () => {
  it('past 5,000 chunks returns the planted nearest match first, logs no scan-cap error, and never scans', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { graph, state } = fakeArcade(corpus(), { indexDim: 3 });
    const hits = await graph.searchChunks(WS, query, 1, deny(true));
    expect(hits.map((h) => h.chunkId)).toEqual(['planted']);
    expect(hits[0].score).toBeCloseTo(cosine(query, [0.99, 0.1, 0]), 6);
    expect(state.scans).toBe(0);
    expect(error).not.toHaveBeenCalled();
    // The beam is the measured 400, and never narrower than k.
    await graph.searchChunks(WS, query, 1000, deny(true));
    expect(state.efSearch).toEqual([400, 1000]);
  });

  it('the scan it replaced misses that match: it ranks the first 5,000 rows', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { graph } = fakeArcade(corpus(), { indexDim: null });
    const hits = await graph.searchChunks(WS, query, 1, deny(true));
    expect(hits.map((h) => h.chunkId)).not.toEqual(['planted']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ranking an arbitrary subset'));
  });

  for (const [label, acl] of [
    ['deny list in the query', deny(true)],
    ['deny list past ACL_DENY_LIST_MAX, by aclNodes stamp', deny(false)],
  ] as const) {
    it(`another workspace, a non-live revision and a denied page never take a slot, even as exact matches (${label})`, async () => {
      const { graph } = fakeArcade(corpus(), { indexDim: 3 });
      // k = 1: had any of the three been filtered after the search, it would
      // have taken the only slot and the answer would be empty.
      expect((await graph.searchChunks(WS, query, 1, acl)).map((h) => h.chunkId)).toEqual(['planted']);
      const ten = (await graph.searchChunks(WS, query, 10, acl)).map((h) => h.chunkId);
      expect(ten).toHaveLength(10);
      for (const forbidden of ['other-ws', 'history', 'secret']) expect(ten).not.toContain(forbidden);
    });
  }

  it('a guest past the list cap is still filtered after the search', async () => {
    const { graph } = fakeArcade(corpus(), { indexDim: 3 });
    const guest: DocumentAclFilter = { kind: 'allow', documentIds: new Set(['doc-planted']), pushdown: false };
    expect((await graph.searchChunks(WS, query, 10, guest)).map((h) => h.chunkId)).toEqual(['planted']);
  });

  it('a chunk of another dimension is never ranked, through the index or the scan', async () => {
    const rows = [chunk('right', { embedding: [0.9, 0.1, 0] }), chunk('wrong-dim', { embedding: [1, 0] })];
    const { graph, state } = fakeArcade(rows, { indexDim: 3 });
    expect((await graph.searchChunks(WS, query, 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['right']);
    // A query of another length than the index (mid-swap) scans, and ranks only its own length.
    expect((await graph.searchChunks(WS, [1, 0], 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['wrong-dim']);
    expect(state.scans).toBe(1);
  });

  it('searchRevisionChunks ranks only the pinned revisions, live or not, through the index', async () => {
    const { graph, state } = fakeArcade(corpus(), { indexDim: 3 });
    const hits = await graph.searchRevisionChunks(WS, ['rev-history', 'rev-7'], query, 50);
    expect(hits[0].chunkId).toBe('history');
    expect(new Set(hits.map((h) => h.revisionId))).toEqual(new Set(['rev-history', 'rev-7']));
    expect(hits).toHaveLength(13); // history + c7, c507 … c5507
    expect(state.scans).toBe(0);
  });
});

describe('readers that need every vector are paged, not capped (#304)', () => {
  it('liveChunks returns every live chunk the reader may see', async () => {
    const { graph } = fakeArcade(corpus(), { indexDim: 3 });
    const live = await graph.liveChunks(WS, deny(true));
    expect(live).toHaveLength(6001); // corpus + planted; not history, secret or ws-2
    expect(new Set(live.map((c) => c.chunkId)).size).toBe(6001);
  });

  it('meanRevisionEmbeddings averages a page over all of its chunks', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => chunk(`m${i}`, { revisionId: 'rev-big', embedding: [i % 2, 1, 0] }));
    const { graph } = fakeArcade(rows, { indexDim: 3 });
    expect((await graph.meanRevisionEmbeddings(WS, ['rev-big'])).get('rev-big')).toEqual([0.5, 1, 0]);
  });
});

describe('ensureSchema builds the index for EMBEDDINGS_DIM (#304)', () => {
  it('creates the index and declares the vector property', async () => {
    const { graph, state } = fakeArcade([], { indexDim: null });
    await graph.ensureSchema(1024);
    expect(state.ddl).toContain('CREATE PROPERTY Chunk.embedding IF NOT EXISTS ARRAY_OF_FLOATS');
    expect(state.ddl.filter((s) => s.includes('LSM_VECTOR'))).toEqual([
      "CREATE INDEX IF NOT EXISTS ON Chunk (embedding) LSM_VECTOR METADATA { dimensions: 1024, similarity: 'COSINE' }",
    ]);
    expect(state.indexDim).toBe(1024);
  });

  it('leaves an index of the right dimension alone', async () => {
    const { graph, state } = fakeArcade([], { indexDim: 1024 });
    await graph.ensureSchema(1024);
    expect(state.ddl.some((s) => s.startsWith('DROP INDEX') || s.includes('LSM_VECTOR'))).toBe(false);
  });

  it('drops and rebuilds it when the dimension changed, and the next search uses the new one', async () => {
    const rows = [chunk('old', { embedding: [1, 0, 0] }), chunk('new', { embedding: [1, 0] })];
    const { graph, state } = fakeArcade(rows, { indexDim: 3 });
    expect((await graph.searchChunks(WS, [1, 0, 0], 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['old']);
    await graph.ensureSchema(2);
    expect(state.ddl).toContain('DROP INDEX `Chunk[embedding]`');
    expect(state.indexDim).toBe(2);
    expect((await graph.searchChunks(WS, [1, 0], 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['new']);
  });

  it('does not fail the worker boot when ArcadeDB refuses the index; search scans instead', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { graph, state } = fakeArcade([chunk('a', { embedding: [1, 0, 0] })], { indexDim: null, rejectIndex: true });
    await expect(graph.ensureSchema(3)).resolves.toBeUndefined();
    expect((await graph.searchChunks(WS, query, 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['a']);
    expect(state.scans).toBe(1);
  });
});
