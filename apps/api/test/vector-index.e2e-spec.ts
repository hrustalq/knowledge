import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';
import { cosine, GraphService } from '../src/graph/graph.service.js';
import { UNFILTERED, type DocumentAclFilter } from '../src/common/document-acl.js';
import type { Env } from '../src/config/env.js';

/**
 * #304 against a real ArcadeDB: the chunk vector index answers the vector
 * leg, with the workspace, live and ACL predicates inside the
 * nearest-neighbour search rather than after it.
 *
 * It creates and drops its own database, so point it at a THROWAWAY server,
 * never the dev stack's:
 *
 *   docker run -d --name arcade-304 -p 2481:2480 \
 *     -e JAVA_OPTS="-Darcadedb.server.rootPassword=playwithdata" arcadedata/arcadedb:26.10.2
 *   ARCADE_VECTOR_TEST_URL=http://localhost:2481 pnpm --filter @knowledge/api exec \
 *     vitest run --config ./vitest.config.e2e.ts test/vector-index.e2e-spec.ts
 *
 * Skipped when ARCADE_VECTOR_TEST_URL is unset.
 */

const BASE = process.env.ARCADE_VECTOR_TEST_URL;
const USER = process.env.ARCADE_VECTOR_TEST_USER ?? 'root';
const PASSWORD = process.env.ARCADE_VECTOR_TEST_PASSWORD ?? 'playwithdata';
const DB = `vector_index_${Date.now()}`;
const D = 16;
const WS = 'ws-big';
const OTHER = 'ws-other';
const SMALL = 'ws-swap';
const SECRET = 'doc-secret';
/** Past the fallback scan's 5,000-chunk cap, which is the point. */
const CORPUS = 6_000;

const auth = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
const server = (command: string) =>
  fetch(`${BASE}/api/v1/server`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ command }) });

/** A seeded PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32 - 0.5;
  };
}
const rand = rng(304);
const vec = (d = D) => Array.from({ length: d }, rand);
/** The query, nudged by `eps` along every axis: closer to it the smaller `eps`. */
const near = (q: number[], eps: number) => q.map((x, i) => x + (i % 2 ? eps : -eps));

const query = vec();
let arcade: ArcadeClient;
let graph: GraphService;

const row = (chunkId: string, extra: Record<string, unknown>) => ({
  chunkId,
  idx: 0,
  workspaceId: WS,
  documentId: `doc-${chunkId}`,
  revisionId: `rev-${chunkId}`,
  live: true,
  text: chunkId,
  headingPath: [],
  embedding: vec(),
  ...extra,
});

async function insert(rows: Array<Record<string, unknown>>) {
  for (let at = 0; at < rows.length; at += 500) await arcade.command('sql', 'INSERT INTO Chunk CONTENT :rows', { rows: rows.slice(at, at + 500) });
}

describe.skipIf(!BASE)('chunk vector index against ArcadeDB (#304)', () => {
  beforeAll(async () => {
    const created = await server(`create database ${DB}`);
    if (!created.ok) throw new Error(`create database failed: ${created.status} ${await created.text()}`);
    const env: Record<string, string> = { ARCADE_URL: BASE!, ARCADE_DB: DB, ARCADE_USER: USER, ARCADE_PASSWORD: PASSWORD };
    arcade = new ArcadeClient({ get: (k: string) => env[k] } as unknown as ConfigService<Env, true>);
    graph = new GraphService(arcade, {} as EntityAliasService);

    // A legacy row of another dimension, written before the index existed.
    await arcade.command('sql', 'CREATE VERTEX TYPE Chunk IF NOT EXISTS');
    await insert([row('legacy-8d', { embedding: near(query, 0).slice(0, 8) })]);
    await graph.ensureSchema(D);

    const corpus = Array.from({ length: CORPUS }, (_, i) => row(`c${i}`, { documentId: `doc-${i % 1000}`, revisionId: `rev-${i % 1000}` }));
    await insert([
      ...corpus,
      // The answer: close to the query, not identical to it.
      row('planted', { embedding: near(query, 0.01) }),
      // Each of these is closer than the answer and must never be returned.
      row('other-ws', { workspaceId: OTHER, embedding: near(query, 0) }),
      row('history', { live: false, embedding: near(query, 0) }),
      row('secret', { documentId: SECRET, aclNodes: [SECRET], embedding: near(query, 0) }),
    ]);
  }, 180_000);

  afterAll(async () => {
    if (BASE) await server(`drop database ${DB}`);
  });

  it('builds the index for EMBEDDINGS_DIM and skips the stored vector of another length', async () => {
    const [type] = await arcade.query<{ indexes: Array<{ name: string; dimensions: number }> }>('sql', "SELECT indexes FROM schema:types WHERE name = 'Chunk'");
    expect(type.indexes.find((i) => i.name === 'Chunk[embedding]')?.dimensions).toBe(D);
    await expect(insert([row('late-8d', { embedding: vec(8) })])).rejects.toThrow(/dimension/i);
  });

  const deny = (pushdown: boolean): DocumentAclFilter => ({ kind: 'deny', documentIds: new Set([SECRET]), nodeIds: [SECRET], pushdown });

  for (const [label, acl] of [
    ['unfiltered', UNFILTERED],
    ['deny list in the query', deny(true)],
    ['deny list past the cap, aclNodes stamps', deny(false)],
  ] as const) {
    it(`past ${CORPUS} chunks returns the planted match first, and nothing from another workspace, history or a denied page (${label})`, async () => {
      const hits = await graph.searchChunks(WS, query, 10, acl);
      const ids = hits.map((h) => h.chunkId);
      expect(hits).toHaveLength(10);
      expect(ids).not.toContain('other-ws');
      expect(ids).not.toContain('history');
      expect(ids).not.toContain('legacy-8d');
      if (acl.kind === 'all') {
        // Nothing hides the secret page from an unfiltered reader: it is the nearest.
        expect(ids.slice(0, 2)).toEqual(['secret', 'planted']);
      } else {
        expect(ids).not.toContain(SECRET);
        expect(ids).not.toContain('secret');
        expect(ids[0]).toBe('planted');
      }
      // score is the cosine the scan used to compute.
      const planted = hits.find((h) => h.chunkId === 'planted')!;
      expect(planted.score).toBeCloseTo(cosine(query, near(query, 0.01)), 5);
    });
  }

  it('a guest sees only the pages on their list', async () => {
    const acl: DocumentAclFilter = { kind: 'allow', documentIds: new Set(['doc-1', 'doc-2']), pushdown: true };
    const hits = await graph.searchChunks(WS, query, 5, acl);
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.documentId))).toEqual(new Set(['doc-1', 'doc-2']));
  });

  it('as of a point, reads the chunks valid then rather than the live flag', async () => {
    await insert([row('was-valid', { live: false, lineage: 'default', validFrom: 100, validTo: 200, embedding: near(query, 0.001) })]);
    const at = { at: 150, knownAt: null, resolved: { kind: 'date', at: 150 } } as never;
    expect((await graph.searchChunks(WS, query, 3, UNFILTERED, at)).map((h) => h.chunkId)).toEqual(['was-valid']);
    expect((await graph.searchChunks(WS, query, 3, UNFILTERED)).map((h) => h.chunkId)).not.toContain('was-valid');
  });

  it('searchRevisionChunks ranks only the pinned revisions, live or not', async () => {
    // rev-7 holds c7, c1007 … c5007; the planted answer and the other workspace's twin are outside the list.
    const hits = await graph.searchRevisionChunks(WS, ['rev-history', 'rev-7'], query, 10);
    expect(hits).toHaveLength(7);
    expect(new Set(hits.map((h) => h.revisionId))).toEqual(new Set(['rev-history', 'rev-7']));
    expect(hits[0].chunkId).toBe('history');
  });

  it('liveChunks and meanRevisionEmbeddings read every row, not the first 5,000', async () => {
    const live = await graph.liveChunks(WS, UNFILTERED);
    // corpus + planted + secret (history and the as-of row are not live; legacy-8d is live, unindexed, still a row).
    expect(live).toHaveLength(CORPUS + 3);
    expect(new Set(live.map((c) => c.chunkId)).size).toBe(live.length);

    const means = await graph.meanRevisionEmbeddings(WS, ['rev-0']);
    // rev-0 holds c0, c1000 … c5000: six chunks, all of them averaged.
    const members = live.filter((c) => /^c\d+$/.test(c.chunkId) && Number(c.chunkId.slice(1)) % 1000 === 0);
    expect(members).toHaveLength(6);
    const expected = members[0].embedding.map((_, i) => members.reduce((s, m) => s + m.embedding[i], 0) / members.length);
    means.get('rev-0')!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
  });

  it('a dimension change rebuilds the index; until a chunk is re-embedded only its own dimension ranks it', async () => {
    const q8 = vec(8);
    // A page indexed under the old model.
    await insert([row('swap-old', { workspaceId: SMALL, embedding: near(query, 0) })]);
    // EMBEDDINGS_DIM=8, the worker reboots: the index is rebuilt and skips every 16-d vector.
    await graph.ensureSchema(8);
    await insert([row('swap-new', { workspaceId: SMALL, embedding: near(q8, 0.01) })]);

    // The new-dimension query goes through the rebuilt index and never sees a 16-d vector.
    expect((await graph.searchChunks(SMALL, q8, 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['swap-new']);
    // A query still in the old dimension (a process not yet restarted) scans, and ranks only 16-d vectors.
    expect((await graph.searchChunks(SMALL, query, 5, UNFILTERED)).map((h) => h.chunkId)).toEqual(['swap-old']);
  }, 120_000);
});
