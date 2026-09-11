import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ArcadeClient } from './arcade.client.js';
import { t } from '../i18n/t.js';

export interface ChunkInput {
  chunkId: string;
  index: number;
  text: string;
  headingPath: string[];
  embedding: number[];
}

export interface ChunkHit {
  chunkId: string;
  documentId: string;
  revisionId: string;
  text: string;
  headingPath: string[];
  score: number;
}

/**
 * Phase 1 ranks by cosine in Node, so every candidate chunk crosses the wire.
 * This caps that fan-out. It is a correctness ceiling, not a tuning knob: past
 * it the ranking is over an arbitrary subset (see `searchChunks`).
 */
const CHUNK_SCAN_LIMIT = 5000;

/**
 * Relation edge types allowed in the graph (plan.md §6). Edge type names are
 * interpolated into SQL, so everything MUST be validated against this list.
 */
export const RELATION_EDGE_TYPES = [
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
  'TAGGED_WITH',
] as const;

export interface FactInput {
  type: string;
  target: { key: string; type: string; name: string };
  /** plan.md §5 fact classes: explicit / frontmatter (deterministic) / inferred (LLM) / curated. */
  extractor: 'explicit' | 'frontmatter' | 'inferred' | 'curated';
  confidence: number;
  /** Inferred facts carry their source span (plan.md §5). */
  sourceChunkId?: string;
  snippet?: string;
}

export interface DocumentRelation {
  type: string;
  targetKey: string;
  entityType: string;
  name: string;
  revisionId: string | null;
  extractor: string;
  confidence: number;
  sourceChunkId?: string;
  snippet?: string;
}

/** One row of the workspace-wide relation graph (Phase 4 traversal). */
export interface WorkspaceRelationGraph {
  edges: Array<{ type: string; documentId: string; targetKey: string; extractor: string; confidence: number }>;
  documents: Record<string, { title: string }>;
  entities: Record<string, { type: string; name: string }>;
}

/**
 * All graph access goes through this service — it is the single injection
 * point for the mandatory server-side workspace predicate (plan.md §6).
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(private readonly arcade: ArcadeClient) {}

  /** Idempotent DDL, applied on worker boot. */
  async ensureSchema(): Promise<void> {
    const statements = [
      'CREATE VERTEX TYPE Document IF NOT EXISTS',
      'CREATE VERTEX TYPE DocumentRevision IF NOT EXISTS',
      'CREATE VERTEX TYPE Chunk IF NOT EXISTS',
      'CREATE VERTEX TYPE Entity IF NOT EXISTS',
      'CREATE EDGE TYPE HAS_REVISION IF NOT EXISTS',
      'CREATE EDGE TYPE HAS_CHUNK IF NOT EXISTS',
      ...RELATION_EDGE_TYPES.map((t) => `CREATE EDGE TYPE ${t} IF NOT EXISTS`),
      'CREATE PROPERTY Document.documentId IF NOT EXISTS STRING',
      'CREATE PROPERTY DocumentRevision.revisionId IF NOT EXISTS STRING',
      'CREATE PROPERTY Chunk.chunkId IF NOT EXISTS STRING',
      'CREATE PROPERTY Chunk.workspaceId IF NOT EXISTS STRING',
      'CREATE PROPERTY Entity.entityKey IF NOT EXISTS STRING',
      'CREATE PROPERTY Entity.workspaceId IF NOT EXISTS STRING',
      'CREATE INDEX IF NOT EXISTS ON Document (documentId) UNIQUE',
      'CREATE INDEX IF NOT EXISTS ON DocumentRevision (revisionId) UNIQUE',
      'CREATE INDEX IF NOT EXISTS ON Chunk (chunkId) UNIQUE',
      'CREATE INDEX IF NOT EXISTS ON Chunk (workspaceId) NOTUNIQUE',
      'CREATE INDEX IF NOT EXISTS ON Entity (workspaceId, entityKey) UNIQUE',
    ];
    for (const s of statements) {
      try {
        await this.arcade.command('sql', s);
      } catch (e) {
        // Older ArcadeDB versions may not support IF NOT EXISTS on every DDL form.
        this.logger.warn(`DDL skipped ("${s}"): ${(e as Error).message}`);
      }
    }
  }

  /**
   * Idempotent (re)index of a revision: previous chunks for the revision are
   * dropped, then the Document/Revision vertices and chunk vertices+edges are
   * recreated. Safe to run on BullMQ retries.
   */
  async upsertRevisionChunks(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    title: string;
    chunks: ChunkInput[];
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title, chunks } = input;

    await this.arcade.command('sql', 'DELETE FROM Chunk WHERE revisionId = :revisionId', { revisionId });
    await this.arcade.command('sql', 'DELETE FROM DocumentRevision WHERE revisionId = :revisionId', { revisionId });

    await this.arcade.command(
      'sql',
      'UPDATE Document SET documentId = :documentId, workspaceId = :workspaceId, title = :title UPSERT WHERE documentId = :documentId',
      { documentId, workspaceId, title },
    );
    await this.arcade.command(
      'sql',
      'CREATE VERTEX DocumentRevision SET revisionId = :revisionId, documentId = :documentId, workspaceId = :workspaceId',
      { revisionId, documentId, workspaceId },
    );
    await this.arcade.command(
      'sql',
      'CREATE EDGE HAS_REVISION FROM (SELECT FROM Document WHERE documentId = :documentId) TO (SELECT FROM DocumentRevision WHERE revisionId = :revisionId)',
      { documentId, revisionId },
    );

    for (const chunk of chunks) {
      await this.arcade.command(
        'sql',
        `CREATE VERTEX Chunk SET chunkId = :chunkId, idx = :idx, workspaceId = :workspaceId,
         documentId = :documentId, revisionId = :revisionId, text = :text,
         headingPath = :headingPath, embedding = :embedding`,
        {
          chunkId: chunk.chunkId,
          idx: chunk.index,
          workspaceId,
          documentId,
          revisionId,
          text: chunk.text,
          headingPath: chunk.headingPath,
          embedding: chunk.embedding,
        },
      );
      await this.arcade.command(
        'sql',
        'CREATE EDGE HAS_CHUNK FROM (SELECT FROM DocumentRevision WHERE revisionId = :revisionId) TO (SELECT FROM Chunk WHERE chunkId = :chunkId)',
        { revisionId, chunkId: chunk.chunkId },
      );
    }
  }

  /** Chunk summaries for a revision (document detail page). */
  async getRevisionChunks(workspaceId: string, revisionId: string): Promise<Array<{ chunkId: string; headingPath: string[]; snippet: string }>> {
    const rows = await this.arcade.query<{ chunkId: string; headingPath: string[]; text: string; idx: number }>(
      'sql',
      'SELECT chunkId, headingPath, text, idx FROM Chunk WHERE workspaceId = :workspaceId AND revisionId = :revisionId ORDER BY idx',
      { workspaceId, revisionId },
    );
    return rows.map((r) => ({
      chunkId: r.chunkId,
      headingPath: r.headingPath ?? [],
      snippet: (r.text ?? '').slice(0, 200),
    }));
  }

  /**
   * Embedding shift between two revisions (plan.md §8 semantic diff):
   * 1 - cosine(mean chunk embedding). Null when either side has no indexed
   * chunks. Lives here so raw vectors never leave the graph layer.
   */
  async revisionEmbeddingShift(
    workspaceId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<{ score: number; meaningful: boolean } | null> {
    const [a, b] = await Promise.all([
      this.meanRevisionEmbedding(workspaceId, fromRevisionId),
      this.meanRevisionEmbedding(workspaceId, toRevisionId),
    ]);
    if (!a || !b || a.length !== b.length) return null;
    const score = Math.max(0, 1 - cosine(a, b));
    return { score: Number(score.toFixed(4)), meaningful: score >= 0.1 };
  }

  private async meanRevisionEmbedding(workspaceId: string, revisionId: string): Promise<number[] | null> {
    const rows = await this.arcade.query<{ embedding: number[] }>(
      'sql',
      'SELECT embedding FROM Chunk WHERE workspaceId = :workspaceId AND revisionId = :revisionId',
      { workspaceId, revisionId },
    );
    const vecs = rows.map((r) => r.embedding).filter((e) => Array.isArray(e) && e.length > 0);
    if (vecs.length === 0) return null;
    const mean = Array.from({ length: vecs[0].length }, () => 0);
    for (const v of vecs) for (let i = 0; i < mean.length; i++) mean[i] += v[i] / vecs.length;
    return mean;
  }

  /** Upsert the Document vertex (needed when relations arrive before first indexing). */
  async upsertDocumentVertex(workspaceId: string, documentId: string, title: string): Promise<void> {
    await this.arcade.command(
      'sql',
      'UPDATE Document SET documentId = :documentId, workspaceId = :workspaceId, title = :title UPSERT WHERE documentId = :documentId',
      { documentId, workspaceId, title },
    );
  }

  /**
   * Erase a document from the graph: its chunks, its revision vertices and the
   * document vertex itself.
   *
   * Deleting a vertex in ArcadeDB removes the edges attached to it, so the
   * document's relation edges (DESCRIBES, DEPENDS_ON, …) go with the Document
   * vertex and need no separate pass — the same reason `upsertRevisionChunks`
   * can re-index by deleting a revision's vertices outright.
   *
   * Carries the mandatory workspace predicate like every other query here
   * (plan.md §6): a document id is not a capability, and a delete is the last
   * place to start trusting one.
   */
  async deleteDocumentGraph(workspaceId: string, documentId: string): Promise<void> {
    for (const type of ['Chunk', 'DocumentRevision', 'Document']) {
      await this.arcade.command(
        'sql',
        `DELETE FROM ${type} WHERE documentId = :documentId AND workspaceId = :workspaceId`,
        { documentId, workspaceId },
      );
    }
  }

  /**
   * Idempotent replace of a revision's frontmatter-derived relation edges
   * (deterministic facts, plan.md §5). Explicit/curated edges are untouched.
   */
  async replaceRevisionFrontmatterFacts(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    title: string;
    facts: FactInput[];
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title, facts } = input;
    for (const type of RELATION_EDGE_TYPES) {
      await this.arcade
        .command('sql', `DELETE FROM ${type} WHERE documentId = :documentId AND revisionId = :revisionId AND extractor = 'frontmatter'`, {
          documentId,
          revisionId,
        })
        .catch(() => {
          /* edge type may hold no rows yet */
        });
    }
    if (facts.length === 0) return;
    await this.upsertDocumentVertex(workspaceId, documentId, title);
    for (const fact of facts) {
      await this.createRelationEdge(workspaceId, documentId, revisionId, fact);
    }
  }

  /** Explicit relations from the REST payload; re-posting the same relation replaces it. */
  async addExplicitRelations(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string | null;
    title: string;
    facts: FactInput[];
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title, facts } = input;
    if (facts.length === 0) return;
    await this.upsertDocumentVertex(workspaceId, documentId, title);
    for (const fact of facts) {
      this.assertEdgeType(fact.type);
      await this.arcade
        .command('sql', `DELETE FROM ${fact.type} WHERE documentId = :documentId AND targetKey = :targetKey AND extractor = 'explicit'`, {
          documentId,
          targetKey: fact.target.key,
        })
        .catch(() => {
          /* no previous edge */
        });
      await this.createRelationEdge(workspaceId, documentId, revisionId, fact);
    }
  }

  /** All relation edges of a document, with provenance (workspace-scoped). */
  async getDocumentRelations(workspaceId: string, documentId: string): Promise<DocumentRelation[]> {
    const out: DocumentRelation[] = [];
    for (const type of RELATION_EDGE_TYPES) {
      const rows = await this.arcade
        .query<{ targetKey: string; revisionId: string | null; extractor: string; confidence: number; sourceChunkId?: string | null; snippet?: string | null }>(
          'sql',
          `SELECT targetKey, revisionId, extractor, confidence, sourceChunkId, snippet FROM ${type} WHERE workspaceId = :workspaceId AND documentId = :documentId`,
          { workspaceId, documentId },
        )
        .catch(() => []);
      for (const r of rows) out.push({ type, targetKey: r.targetKey, entityType: '', name: '', revisionId: r.revisionId ?? null, extractor: r.extractor, confidence: r.confidence, sourceChunkId: r.sourceChunkId ?? undefined, snippet: r.snippet ?? undefined });
    }
    if (out.length === 0) return out;

    const keys = [...new Set(out.map((r) => r.targetKey))];
    const entities = await this.arcade.query<{ entityKey: string; entityType: string; name: string }>(
      'sql',
      'SELECT entityKey, entityType, name FROM Entity WHERE workspaceId = :workspaceId AND entityKey IN :keys',
      { workspaceId, keys },
    );
    const byKey = new Map(entities.map((e) => [e.entityKey, e]));
    for (const r of out) {
      const e = byKey.get(r.targetKey);
      r.entityType = e?.entityType ?? 'entity';
      r.name = e?.name ?? r.targetKey;
    }
    return out;
  }

  private async createRelationEdge(
    workspaceId: string,
    documentId: string,
    revisionId: string | null,
    fact: FactInput,
  ): Promise<void> {
    this.assertEdgeType(fact.type);
    await this.arcade.command(
      'sql',
      'UPDATE Entity SET entityKey = :key, workspaceId = :workspaceId, entityType = :entityType, name = :name UPSERT WHERE entityKey = :key AND workspaceId = :workspaceId',
      { key: fact.target.key, workspaceId, entityType: fact.target.type, name: fact.target.name },
    );
    await this.arcade.command(
      'sql',
      `CREATE EDGE ${fact.type} FROM (SELECT FROM Document WHERE documentId = :documentId) TO (SELECT FROM Entity WHERE entityKey = :key AND workspaceId = :workspaceId) SET workspaceId = :workspaceId, documentId = :documentId, revisionId = :revisionId, targetKey = :key, extractor = :extractor, confidence = :confidence, sourceChunkId = :sourceChunkId, snippet = :snippet`,
      {
        documentId,
        key: fact.target.key,
        workspaceId,
        revisionId,
        extractor: fact.extractor,
        confidence: fact.confidence,
        sourceChunkId: fact.sourceChunkId ?? null,
        snippet: fact.snippet ?? null,
      },
    );
  }

  private assertEdgeType(type: string): void {
    if (!(RELATION_EDGE_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Relation type ${type} is not in the allowed edge-type list`);
    }
  }

  /**
   * Idempotent replace of a revision's LLM-inferred relation edges (plan.md
   * §5 "inferred" class). Facts duplicating an existing curated or explicit
   * edge (same type + target) are skipped — curated/explicit facts are never
   * silently overwritten by automated re-extraction.
   */
  async replaceRevisionInferredFacts(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    title: string;
    facts: FactInput[];
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title, facts } = input;
    for (const type of RELATION_EDGE_TYPES) {
      await this.arcade
        .command('sql', `DELETE FROM ${type} WHERE documentId = :documentId AND revisionId = :revisionId AND extractor = 'inferred'`, {
          documentId,
          revisionId,
        })
        .catch(() => {
          /* edge type may hold no rows yet */
        });
    }
    if (facts.length === 0) return;

    const protectedPairs = new Set<string>();
    for (const rel of await this.getDocumentRelations(workspaceId, documentId)) {
      if (rel.extractor === 'curated' || rel.extractor === 'explicit') {
        protectedPairs.add(`${rel.type} ${rel.targetKey}`);
      }
    }

    await this.upsertDocumentVertex(workspaceId, documentId, title);
    for (const fact of facts) {
      if (protectedPairs.has(`${fact.type} ${fact.target.key}`)) continue;
      await this.createRelationEdge(workspaceId, documentId, revisionId, fact);
    }
  }

  /**
   * Curate a relation (plan.md §5 "curated" class): user-confirmed, confidence
   * 1, replaces any inferred/curated edge with the same (type, target).
   */
  async curateRelation(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string | null;
    title: string;
    fact: FactInput;
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title, fact } = input;
    this.assertEdgeType(fact.type);
    await this.arcade
      .command(
        'sql',
        `DELETE FROM ${fact.type} WHERE documentId = :documentId AND targetKey = :targetKey AND extractor IN ['inferred', 'curated']`,
        { documentId, targetKey: fact.target.key },
      )
      .catch(() => {
        /* no previous edge */
      });
    await this.upsertDocumentVertex(workspaceId, documentId, title);
    await this.createRelationEdge(workspaceId, documentId, revisionId, { ...fact, extractor: 'curated', confidence: 1 });
  }

  /** Delete a document's relation edges by (type, target), optionally one fact class only. */
  async deleteRelations(
    workspaceId: string,
    documentId: string,
    type: string,
    targetKey: string,
    extractor?: string,
  ): Promise<void> {
    this.assertEdgeType(type);
    const extra = extractor ? ' AND extractor = :extractor' : '';
    await this.arcade
      .command(
        'sql',
        `DELETE FROM ${type} WHERE workspaceId = :workspaceId AND documentId = :documentId AND targetKey = :targetKey${extra}`,
        { workspaceId, documentId, targetKey, ...(extractor ? { extractor } : {}) },
      )
      .catch(() => {
        /* nothing to delete */
      });
  }

  /**
   * Document ids carrying ANY of the given tag entity keys (`tag:<name>`), for
   * the search tag filter. Deliberately narrow: the full relation graph is a
   * query per edge type, far too much work to answer "which docs have tag X",
   * and the tag filter must also work in semantic/keyword mode where the
   * expansion graph is never loaded.
   */
  async getDocumentIdsByTags(workspaceId: string, tagKeys: string[]): Promise<Set<string>> {
    if (tagKeys.length === 0) return new Set();
    const rows = await this.arcade
      .query<{ documentId: string }>(
        'sql',
        'SELECT documentId FROM TAGGED_WITH WHERE workspaceId = :workspaceId AND targetKey IN :keys LIMIT 20000',
        { workspaceId, keys: tagKeys },
      )
      // ArcadeDB throws when the edge type holds no rows yet; "no tag edges"
      // must mean "no matches", not a 500.
      .catch(() => []);
    return new Set(rows.map((r) => r.documentId));
  }

  /**
   * The workspace's full relation graph (edges + node labels) for Phase 4
   * traversal. Small-scale by design — BFS happens in Node, mirroring the
   * cosine-in-Node search approach; swap for native traversal later.
   */
  async getWorkspaceRelationGraph(workspaceId: string): Promise<WorkspaceRelationGraph> {
    const edges: WorkspaceRelationGraph['edges'] = [];
    for (const type of RELATION_EDGE_TYPES) {
      const rows = await this.arcade
        .query<{ documentId: string; targetKey: string; extractor: string; confidence: number }>(
          'sql',
          `SELECT documentId, targetKey, extractor, confidence FROM ${type} WHERE workspaceId = :workspaceId LIMIT 20000`,
          { workspaceId },
        )
        .catch(() => []);
      for (const r of rows) edges.push({ type, documentId: r.documentId, targetKey: r.targetKey, extractor: r.extractor, confidence: r.confidence });
    }

    const docs = await this.arcade.query<{ documentId: string; title: string }>(
      'sql',
      'SELECT documentId, title FROM Document WHERE workspaceId = :workspaceId LIMIT 20000',
      { workspaceId },
    );
    const ents = await this.arcade.query<{ entityKey: string; entityType: string; name: string }>(
      'sql',
      'SELECT entityKey, entityType, name FROM Entity WHERE workspaceId = :workspaceId LIMIT 20000',
      { workspaceId },
    );
    return {
      edges,
      documents: Object.fromEntries(docs.map((d) => [d.documentId, { title: d.title }])),
      entities: Object.fromEntries(ents.map((e) => [e.entityKey, { type: e.entityType, name: e.name }])),
    };
  }

  /**
   * Phase 1 semantic search: fetch workspace-scoped chunks and rank by cosine
   * similarity in Node. Swap the body for ArcadeDB HNSW later — same signature.
   */
  async searchChunks(workspaceId: string, queryEmbedding: number[], k: number): Promise<ChunkHit[]> {
    const rows = await this.arcade.query<{
      chunkId: string;
      documentId: string;
      revisionId: string;
      text: string;
      headingPath: string[];
      embedding: number[];
    }>(
      'sql',
      `SELECT chunkId, documentId, revisionId, text, headingPath, embedding FROM Chunk WHERE workspaceId = :workspaceId LIMIT ${CHUNK_SCAN_LIMIT}`,
      { workspaceId },
    );

    // Ranking is exhaustive-scan, so hitting the cap does not degrade results
    // gracefully — it ranks an arbitrary subset and returns it as if it were
    // the best match. Say so loudly; the fix is a native vector index.
    if (rows.length >= CHUNK_SCAN_LIMIT) {
      this.logger.error(
        `Workspace ${workspaceId} has at least ${CHUNK_SCAN_LIMIT} chunks — the scan cap. ` +
          'Vector search is now ranking an arbitrary subset and silently missing matches. ' +
          'Move to an ArcadeDB HNSW index before trusting these results.',
      );
    }

    return rows
      .filter((r) => Array.isArray(r.embedding) && r.embedding.length === queryEmbedding.length)
      .map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        revisionId: r.revisionId,
        text: r.text ?? '',
        headingPath: r.headingPath ?? [],
        score: cosine(queryEmbedding, r.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * Phase 5 trusted-operator queries (plan.md §9): read-only, single
   * statement, row-capped. The caller's query is wrapped in an outer SELECT
   * carrying the mandatory workspace predicate, so rows without a matching
   * workspaceId property are filtered out — deny by default.
   */
  async operatorQuery(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    const q = query.trim().replace(/;+\s*$/, '');
    if (!/^select\b/i.test(q)) throw new BadRequestException(t('error.graph.selectOnly'));
    if (q.includes(';')) throw new BadRequestException(t('error.graph.singleStatement'));
    const forbidden = /\b(insert|update|delete|create|drop|alter|truncate|grant|revoke|backup|import|export)\b/i;
    if (forbidden.test(q)) {
      throw new BadRequestException(t('error.graph.writeKeyword'));
    }
    const cap = Math.max(1, Math.floor(limit));
    const rows = await this.arcade.query<Record<string, unknown>>(
      'sql',
      `SELECT FROM ( ${q} ) WHERE workspaceId = :workspaceId LIMIT ${cap + 1}`,
      { workspaceId },
    );
    return { rows: rows.slice(0, cap), truncated: rows.length > cap };
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
