import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphService } from '../src/graph/graph.service.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';
import { OpenSearchFulltextProvider } from '../src/fulltext/opensearch.provider.js';
import { UNFILTERED, type DocumentAclFilter } from '../src/common/document-acl.js';

/**
 * The stores' half of permission-aware retrieval, #76 phase 3.
 *
 * What is pinned:
 * 1. **GraphService applies the filter in every workspace-wide read** — in
 *    the query while the list is short, in memory past ACL_DENY_LIST_MAX, with
 *    the same answer either way.
 * 2. **Entities do not outlive their pages.** An entity no visible edge
 *    mentions is dropped, so a hidden page cannot leak a name it introduced.
 *    With nothing hidden the graph is exactly what it was before.
 * 3. **Stamps, not embeddings.** Indexing stamps `aclNodes`; a restamp
 *    rewrites them and touches nothing else.
 * 4. **OpenSearch gets an exact id predicate while it fits**, and falls back
 *    to the stamps (members) or nothing (guests) past it — then filters again.
 */

const WS = 'ws-1';
const OPEN = 'doc-open';
const SECRET = 'doc-secret';

/**
 * A stand-in for ArcadeDB honouring exactly the predicates under test: the
 * live flag and the ACL clause `GraphService` appends (`documentId IN :aclDocs`
 * / `NOT (documentId IN :aclDocs)`). A read that forgot the clause gets every
 * row back, which is what the in-memory half then has to catch.
 */
function fakeArcade(tables: Record<string, Array<Record<string, unknown>>>) {
  const typeOf = (sql: string) => /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
  const arcade = {
    query: vi.fn(async (_lang: string, sql: string, params: Record<string, unknown> = {}) => {
      let out = tables[typeOf(sql)] ?? [];
      if (/\(live IS NULL OR live = true\)/.test(sql)) out = out.filter((r) => r.live !== false);
      const ids = params.aclDocs as string[] | undefined;
      if (/NOT \(documentId IN :aclDocs\)/.test(sql)) out = out.filter((r) => !ids!.includes(r.documentId as string));
      else if (/documentId IN :aclDocs/.test(sql)) out = out.filter((r) => ids!.includes(r.documentId as string));
      return out;
    }),
    command: vi.fn(async () => []),
  };
  const aliases = { resolveAll: vi.fn(async (_ws: string, keys: string[]) => keys) };
  return { graph: new GraphService(arcade as unknown as ArcadeClient, aliases as unknown as EntityAliasService), arcade };
}

const deny = (pushdown: boolean): DocumentAclFilter => ({ kind: 'deny', documentIds: new Set([SECRET]), nodeIds: [SECRET], pushdown });
const allow = (ids: string[], pushdown = true): DocumentAclFilter => ({ kind: 'allow', documentIds: new Set(ids), pushdown });

const edge = (documentId: string, targetKey: string) => ({ documentId, targetKey, extractor: 'explicit', confidence: 1 });
const tables = (withTags = false) => ({
  DEPENDS_ON: [edge(OPEN, 'service:billing'), edge(SECRET, 'service:billing'), edge(SECRET, 'project:merger')],
  Document: [
    { documentId: OPEN, title: 'Open' },
    { documentId: SECRET, title: 'Secret' },
  ],
  Entity: [
    { entityKey: 'service:billing', entityType: 'service', name: 'Billing' },
    { entityKey: 'project:merger', entityType: 'project', name: 'Merger' },
    { entityKey: 'tag:unused', entityType: 'tag', name: 'unused' },
  ],
  // TAGGED_WITH is a relation edge type too; only the tag-filter case loads it.
  ...(withTags ? { TAGGED_WITH: [edge(OPEN, 'tag:q3'), edge(SECRET, 'tag:q3')] } : {}),
  Chunk: [
    { chunkId: 'o:0', documentId: OPEN, revisionId: 'o', text: 'open', headingPath: [], embedding: [1, 0] },
    { chunkId: 's:0', documentId: SECRET, revisionId: 's', text: 'secret', headingPath: [], embedding: [1, 0] },
  ],
});

describe('GraphService under a DocumentAclFilter', () => {
  for (const pushdown of [true, false]) {
    it(`drops a hidden page, its edges and the entities only it names (${pushdown ? 'in the query' : 'in memory'})`, async () => {
      const { graph, arcade } = fakeArcade(tables());
      const g = await graph.getWorkspaceRelationGraph(WS, deny(pushdown));
      expect(g.edges.map((e) => `${e.documentId}→${e.targetKey}`)).toEqual([`${OPEN}→service:billing`]);
      expect(Object.keys(g.documents)).toEqual([OPEN]);
      expect(Object.keys(g.entities)).toEqual(['service:billing']);
      expect(JSON.stringify(g)).not.toMatch(/Secret|Merger/);
      const sent = arcade.query.mock.calls.some(([, sql]) => /aclDocs/.test(sql as string));
      expect(sent).toBe(pushdown);
    });
  }

  it('returns the graph it always returned when nothing is hidden', async () => {
    const { graph } = fakeArcade(tables());
    const g = await graph.getWorkspaceRelationGraph(WS, UNFILTERED);
    expect(g.edges).toHaveLength(3);
    // An entity with no live edge is still listed, as before #76.
    expect(Object.keys(g.entities)).toContain('tag:unused');
  });

  it("gives a guest only their pages, and nothing at all for an empty grant list", async () => {
    const { graph, arcade } = fakeArcade(tables());
    expect(Object.keys((await graph.getWorkspaceRelationGraph(WS, allow([OPEN]))).documents)).toEqual([OPEN]);
    const none = await graph.getWorkspaceRelationGraph(WS, allow([]));
    expect(none.edges).toEqual([]);
    expect(none.entities).toEqual({});
    // Sent as [''] — no page has an empty id — never as an empty list or no clause.
    const docRead = arcade.query.mock.calls.filter(([, sql]) => /FROM Document /.test(sql as string)).at(-1)!;
    expect(docRead[2]).toMatchObject({ aclDocs: [''] });
  });

  it('keeps hidden pages out of vector search and the tag filter', async () => {
    for (const pushdown of [true, false]) {
      const { graph } = fakeArcade(tables(true));
      expect((await graph.searchChunks(WS, [1, 0], 10, deny(pushdown))).map((h) => h.documentId)).toEqual([OPEN]);
      expect([...(await graph.getDocumentIdsByTags(WS, ['tag:q3'], deny(pushdown)))]).toEqual([OPEN]);
    }
  });

  it('stamps aclNodes when indexing and rewrites only the stamps on a restamp', async () => {
    const { graph, arcade } = fakeArcade({});
    await graph.upsertRevisionChunks({
      workspaceId: WS,
      documentId: SECRET,
      revisionId: 's',
      title: 'Secret',
      chunks: [{ chunkId: 's:0', index: 0, text: 't', headingPath: [], embedding: [1] }],
      live: true,
      aclNodes: [SECRET],
    });
    const chunkWrite = arcade.command.mock.calls.find(([, sql]) => /CREATE VERTEX Chunk/.test(sql as string))!;
    expect(chunkWrite[2]).toMatchObject({ aclNodes: [SECRET], aclRestricted: true });

    arcade.command.mockClear();
    await graph.restampDocument(WS, SECRET, []);
    const sqls = arcade.command.mock.calls.map(([, sql]) => sql as string);
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) {
      expect(sql).toMatch(/^UPDATE (Document|Chunk) SET aclNodes = :aclNodes, aclRestricted = :aclRestricted WHERE workspaceId/);
    }
    expect(arcade.command.mock.calls[0]![2]).toMatchObject({ aclNodes: [], aclRestricted: false });
  });
});

describe('OpenSearch under a DocumentAclFilter', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The provider with `fetch` stubbed; returns the parsed body of every request it made. */
  function provider(hits: Array<{ documentId: string }> = []) {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        bodies.push({ url, body: init.body ? JSON.parse(init.body) : {} });
        return new Response(
          JSON.stringify({
            hits: { hits: hits.map((h) => ({ _score: 1, _source: { ...h, chunkId: h.documentId, revisionId: 'r', text: '', headingPath: [] } })) },
          }),
          { status: 200 },
        );
      }),
    );
    return { os: new OpenSearchFulltextProvider('http://os', 'idx'), bodies };
  }
  const searchBody = (bodies: Array<{ url: string; body: Record<string, unknown> }>) =>
    (bodies.find((b) => b.url.endsWith('/_search'))!.body.query as { bool: Record<string, unknown[]> }).bool;

  it("excludes a member's hidden pages by id while the list fits", async () => {
    const { os, bodies } = provider([{ documentId: OPEN }, { documentId: SECRET }]);
    const hits = await os.search(WS, 'q', 5, deny(true));
    expect(searchBody(bodies).must_not).toContainEqual({ terms: { documentId: [SECRET] } });
    // A row the engine returned anyway is dropped on the way out.
    expect(hits.map((h) => h.documentId)).toEqual([OPEN]);
  });

  it('falls back to the aclNodes stamps past the list cap', async () => {
    const { os, bodies } = provider();
    await os.search(WS, 'q', 5, deny(false));
    expect(searchBody(bodies).must_not).toContainEqual({ terms: { aclNodes: [SECRET] } });
  });

  it("filters a guest to their pages, and leaves an unrestricted search as it was", async () => {
    const guest = provider();
    await guest.os.search(WS, 'q', 5, allow([OPEN]));
    expect(searchBody(guest.bodies).filter).toContainEqual({ terms: { documentId: [OPEN] } });

    vi.unstubAllGlobals();
    const open = provider();
    await open.os.search(WS, 'q', 5, UNFILTERED);
    expect(searchBody(open.bodies)).toMatchObject({ filter: [{ term: { workspaceId: WS } }], must_not: [{ term: { live: false } }] });
  });

  it('restamps every row of a page with one update_by_query', async () => {
    const { os, bodies } = provider();
    await os.restamp(WS, SECRET, [SECRET]);
    const update = bodies.find((b) => b.url.includes('_update_by_query'))!.body as { script: { params: unknown } };
    expect(update.script.params).toEqual({ aclNodes: [SECRET], aclRestricted: true });
  });
});
