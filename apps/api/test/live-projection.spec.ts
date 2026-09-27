import { describe, expect, it, vi } from 'vitest';
import { GraphService } from '../src/graph/graph.service.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';
import { IngestionProcessor } from '../src/ingestion/ingestion.processor.js';

/**
 * #83 — only the live projection (the indexed head of each page's default
 * branch) may be served by workspace-wide reads. Older revisions and unmerged
 * branches keep their chunks and edges for the MR diff and the facts history,
 * but must not reach search, the tag filter, the graph or an agent.
 */

const WS = 'ws-1';
const DOC = 'doc-1';

/**
 * A stand-in for ArcadeDB that holds rows per type and honours exactly one
 * predicate: the live filter. That is the point — a read that forgets to ask
 * for it gets every revision back, which is what dev did before #83.
 */
function fakeArcade(tables: Record<string, Array<Record<string, unknown>>>) {
  const commands: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const typeOf = (sql: string) => /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
  const arcade = {
    query: vi.fn(async (_lang: string, sql: string) => {
      const rows = tables[typeOf(sql)] ?? [];
      return /\(live IS NULL OR live = true\)/.test(sql) ? rows.filter((r) => r.live !== false) : rows;
    }),
    command: vi.fn(async (_lang: string, sql: string, params?: Record<string, unknown>) => {
      commands.push({ sql, params });
      return [];
    }),
  };
  return { arcade, commands };
}

function graphWith(tables: Record<string, Array<Record<string, unknown>>>) {
  const { arcade, commands } = fakeArcade(tables);
  const aliases = { resolveAll: vi.fn(async (_ws: string, keys: string[]) => keys) };
  const graph = new GraphService(arcade as unknown as ArcadeClient, aliases as unknown as EntityAliasService);
  return { graph, arcade, commands };
}

const emb = [1, 0, 0];
const chunk = (revisionId: string, live: boolean | undefined, text: string) => ({
  chunkId: `${revisionId}:0`,
  documentId: DOC,
  revisionId,
  text,
  headingPath: [],
  embedding: emb,
  ...(live === undefined ? {} : { live }),
});

describe('GraphService reads serve the live projection only (#83)', () => {
  it('searchChunks does not return a removed sentence from an older revision', async () => {
    const { graph } = graphWith({
      Chunk: [chunk('r1', false, 'Alpha unique-token-zebra'), chunk('r2', true, 'Alpha')],
    });
    const hits = await graph.searchChunks(WS, emb, 10);
    expect(hits.map((h) => h.revisionId)).toEqual(['r2']);
  });

  it('searchChunks does not return an unmerged branch draft', async () => {
    const { graph } = graphWith({
      Chunk: [chunk('main-head', true, 'Alpha'), chunk('feature-x', false, 'beta-draft-token')],
    });
    const hits = await graph.searchChunks(WS, emb, 10);
    expect(hits.some((h) => h.text.includes('beta-draft-token'))).toBe(false);
  });

  it('rows written before the flag existed stay visible until the backfill', async () => {
    const { graph } = graphWith({ Chunk: [chunk('legacy', undefined, 'old but only copy')] });
    expect(await graph.searchChunks(WS, emb, 10)).toHaveLength(1);
  });

  it('the tag filter drops a page whose tag was removed', async () => {
    const { graph } = graphWith({
      TAGGED_WITH: [{ documentId: DOC, targetKey: 'tag:legacy', live: false }],
    });
    expect([...(await graph.getDocumentIdsByTags(WS, ['tag:legacy']))]).toEqual([]);
  });

  it('the workspace relation graph drops edges of a retired revision', async () => {
    const { graph } = graphWith({
      DEPENDS_ON: [
        { documentId: DOC, targetKey: 'service:old', extractor: 'frontmatter', confidence: 1, live: false },
        { documentId: DOC, targetKey: 'service:new', extractor: 'frontmatter', confidence: 1, live: true },
      ],
      Document: [{ documentId: DOC, title: 'Doc' }],
      Entity: [],
    });
    const g = await graph.getWorkspaceRelationGraph(WS);
    expect(g.edges.map((e) => e.targetKey)).toEqual(['service:new']);
  });

  it('getDocumentRelations keeps history by default and narrows with liveOnly', async () => {
    const { graph } = graphWith({
      DEPENDS_ON: [
        { targetKey: 'service:old', revisionId: 'r1', extractor: 'frontmatter', confidence: 1, live: false },
        { targetKey: 'service:new', revisionId: 'r2', extractor: 'frontmatter', confidence: 1, live: true },
      ],
      Entity: [],
    });
    // The semantic diff and the facts timeline read history by revision id.
    expect((await graph.getDocumentRelations(WS, DOC)).map((r) => r.targetKey)).toEqual(['service:old', 'service:new']);
    const live = await graph.getDocumentRelations(WS, DOC, { liveOnly: true });
    expect(live.map((r) => r.targetKey)).toEqual(['service:new']);
  });
});

describe('GraphService.setLiveRevision (#83)', () => {
  it('raises the new revision before lowering the rest, scoped to the page and workspace', async () => {
    const { graph, commands } = graphWith({});
    await graph.setLiveRevision(WS, DOC, 'r2');

    const updates = commands.filter((c) => /^UPDATE/.test(c.sql));
    const firstLower = updates.findIndex((c) => /live = false/.test(c.sql));
    const lastRaise = updates.map((c) => /live = true/.test(c.sql)).lastIndexOf(true);
    expect(firstLower).toBeGreaterThan(lastRaise);

    for (const c of updates) {
      expect(c.sql).toContain('workspaceId = :workspaceId AND documentId = :documentId');
      expect(c.params).toMatchObject({ workspaceId: WS, documentId: DOC, revisionId: 'r2' });
    }
    // Explicit and curated edges are document-level: never retired.
    for (const c of updates.filter((u) => !/^UPDATE Chunk/.test(u.sql))) {
      expect(c.sql).toContain("extractor IN ['frontmatter', 'inferred']");
    }
    expect(updates.some((c) => /^UPDATE Chunk SET live = false .*revisionId <> :revisionId/.test(c.sql))).toBe(true);
  });

  it('never deletes — branch revisions are still needed for the MR diff', async () => {
    const { graph, commands } = graphWith({});
    await graph.setLiveRevision(WS, DOC, 'r2');
    expect(commands.some((c) => /^DELETE/i.test(c.sql))).toBe(false);
  });
});

describe('IngestionProcessor stamps and reconciles the live projection (#83)', () => {
  function processorFor(opts: { revisionId: string; headId: string; headStatus?: string }) {
    const revision = {
      id: opts.revisionId,
      documentId: DOC,
      authorId: 'u',
      s3Key: `workspaces/${WS}/documents/${DOC}/revisions/${opts.revisionId}/source.md`,
      contentType: 'text/markdown',
      document: { id: DOC, workspaceId: WS, title: 'Doc' },
    };
    const prisma = {
      ingestionJob: {
        findUnique: vi.fn(async () => ({ id: 'job', status: 'queued', workspaceId: WS, revisionId: revision.id, payload: {} })),
        update: vi.fn(),
      },
      documentRevision: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === revision.id ? revision : { id: where.id, status: opts.headStatus ?? 'indexed' },
        ),
        update: vi.fn(),
      },
      document: {
        findUnique: vi.fn(async () => ({ defaultBranch: 'main', branches: [{ name: 'main', headRevisionId: opts.headId }] })),
      },
      $transaction: vi.fn(async () => []),
    };
    const graph = {
      upsertRevisionChunks: vi.fn(),
      replaceRevisionFrontmatterFacts: vi.fn(),
      replaceRevisionInferredFacts: vi.fn(),
      setLiveRevision: vi.fn(),
      getWorkspaceRelationGraph: vi.fn(async () => ({ edges: [], documents: {}, entities: {} })),
    };
    const fulltext = { enabled: false, indexRevisionChunks: vi.fn(), setLiveRevision: vi.fn() };
    const processor = new IngestionProcessor(
      prisma as never,
      { getObjectText: vi.fn(async () => '---\ntags: [legacy]\n---\n# T\n\nAlpha unique-token-zebra\n'), putObjectJson: vi.fn() } as never,
      graph as never,
      { embedBatch: vi.fn(async (xs: string[]) => xs.map(() => emb)) } as never,
      { forWorkspace: vi.fn(async () => ({ extractor: { enabled: false }, tuning: {}, config: {} })) } as never,
      fulltext as never,
      { get: vi.fn(() => 0) } as never,
      { publish: vi.fn() } as never,
      { enqueue: vi.fn() } as never,
    );
    return { processor, graph, fulltext };
  }
  const run = (p: IngestionProcessor) => p.process({ data: { ingestionJobId: 'job' } } as never);

  it('the default-branch head is written live and becomes the live revision', async () => {
    const { processor, graph, fulltext } = processorFor({ revisionId: 'r2', headId: 'r2' });
    await run(processor);
    expect(graph.upsertRevisionChunks).toHaveBeenCalledWith(expect.objectContaining({ live: true }));
    expect(graph.replaceRevisionFrontmatterFacts).toHaveBeenCalledWith(expect.objectContaining({ live: true }));
    expect(graph.replaceRevisionInferredFacts).toHaveBeenCalledWith(expect.objectContaining({ live: true }));
    expect(graph.setLiveRevision).toHaveBeenCalledWith(WS, DOC, 'r2');
    expect(fulltext.setLiveRevision).toHaveBeenCalledWith(WS, DOC, 'r2');
  });

  it('a branch revision is written but never made live', async () => {
    const { processor, graph } = processorFor({ revisionId: 'feature-x', headId: 'r2' });
    await run(processor);
    expect(graph.upsertRevisionChunks).toHaveBeenCalledWith(expect.objectContaining({ live: false }));
    expect(graph.replaceRevisionFrontmatterFacts).toHaveBeenCalledWith(expect.objectContaining({ live: false }));
    expect(graph.setLiveRevision).not.toHaveBeenCalledWith(WS, DOC, 'feature-x');
  });

  it('keeps the previous revision live while the new head is still indexing', async () => {
    const { processor, graph } = processorFor({ revisionId: 'r1', headId: 'r2', headStatus: 'indexing' });
    await run(processor);
    expect(graph.setLiveRevision).not.toHaveBeenCalled();
  });
});
