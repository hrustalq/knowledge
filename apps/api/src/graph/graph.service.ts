import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  RELATION_EDGE_TYPES,
  entityNameOf,
  entityTypeOf,
  normalizeEntityKey,
} from '@knowledge/contracts';
import { aclAdmits, type DocumentAclFilter } from '../common/document-acl.js';
import { ArcadeClient } from './arcade.client.js';
import { EntityAliasService } from './entity-alias.service.js';
import { diffRevisionFacts, type ExistingFactRow, type Lineage, type RevisionStamp } from './temporal.js';
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

/** A live chunk as stored, vector included (`liveChunks`). */
export interface StoredChunk {
  chunkId: string;
  documentId: string;
  idx: number;
  text: string;
  headingPath: string[];
  embedding: number[];
}

/**
 * Phase 1 ranks by cosine in Node, so every candidate chunk crosses the wire.
 * This caps that fan-out. It is a correctness ceiling, not a tuning knob: past
 * it the ranking is over an arbitrary subset (see `searchChunks`).
 */
const CHUNK_SCAN_LIMIT = 5000;
/** Revisions averaged per read in `meanRevisionEmbeddings`, so each read stays under the scan cap. */
const MEAN_BATCH = 100;

/**
 * The live-projection predicate (#83). A chunk or revision-scoped edge is
 * `live` when it belongs to the indexed head of its document's default branch;
 * everything else — older revisions, unmerged branches — is history, kept for
 * the revision diff and `revisionEmbeddingShift` but never served by a
 * workspace-wide read. `IS NULL` keeps rows written before the flag existed
 * visible until `make graph-live-backfill` stamps them, so shipping this
 * changes nothing until the data is reconciled.
 */
const LIVE = '(live IS NULL OR live = true)';

/** An edge row's time axes (#81), in the order `EdgeTemporal` names them. */
const TEMPORAL_COLUMNS = 'validFrom, validTo, ingestedAt, expiredAt, retractedBy, lineage';

function temporalOf(r: Partial<EdgeTemporal>): EdgeTemporal {
  return {
    validFrom: r.validFrom ?? null,
    validTo: r.validTo ?? null,
    ingestedAt: r.ingestedAt ?? null,
    expiredAt: r.expiredAt ?? null,
    retractedBy: r.retractedBy ?? null,
    lineage: r.lineage ?? null,
  };
}

/**
 * A new edge's time axes. A document-level edge (explicit, curated, code) is
 * valid from the moment it is written. A revision-scoped one waits for
 * `stampRevisions`, which reads its revision's times from PG.
 */
function freshTemporal(extractor: string): EdgeTemporal {
  const now = Date.now();
  const scoped = (REVISION_SCOPED_EXTRACTORS as readonly string[]).includes(extractor);
  return {
    validFrom: scoped ? null : now,
    validTo: null,
    ingestedAt: now,
    expiredAt: null,
    retractedBy: null,
    lineage: scoped ? null : 'default',
  };
}

/**
 * The page-permission predicate for a read keyed by `documentId` (#76): the
 * clause to append and its parameter, or null when the read must instead be
 * filtered in memory (`all`, or a list past `ACL_DENY_LIST_MAX`). An empty
 * guest list is still pushed down, as `['']` — no page has an empty id, so it
 * matches nothing, which is the answer.
 */
function aclClause(acl: DocumentAclFilter): { sql: string; params: { aclDocs: string[] } } | null {
  if (acl.kind === 'all' || !acl.pushdown) return null;
  const aclDocs = acl.documentIds.size ? [...acl.documentIds] : [''];
  return {
    sql: acl.kind === 'allow' ? ' AND documentId IN :aclDocs' : ' AND NOT (documentId IN :aclDocs)',
    params: { aclDocs },
  };
}

/** A code edge's provenance: the usage files, cut at a whole path. */
function usageSnippet(usages: readonly string[], max = 1000): string {
  const shown: string[] = [];
  let used = 0;
  for (const path of usages) {
    if (shown.length > 0 && used + path.length + 2 > max) break;
    shown.push(path);
    used += path.length + 2;
  }
  const rest = usages.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** Fact classes whose edges belong to one revision and so follow its liveness. */
const REVISION_SCOPED_EXTRACTORS = ['frontmatter', 'inferred', 'spec'] as const;
const SCOPED_SQL = `extractor IN [${REVISION_SCOPED_EXTRACTORS.map((e) => `'${e}'`).join(', ')}]`;

/**
 * Relation edge types allowed in the graph (plan.md §6). Edge type names are
 * interpolated into SQL, so everything MUST be validated against this list.
 *
 * The list itself now lives in `@knowledge/contracts`: seven consumers have to
 * agree on it and, until it moved, did not — this file carried eight types, the
 * frontmatter parser and the DTO seven, the workflow canvas five. It is
 * re-exported here so every existing importer of this module is unchanged, and
 * so `assertEdgeType` keeps guarding the same list the writers validate against.
 * Share it; never fork it.
 */
export { RELATION_EDGE_TYPES };

export interface FactInput {
  type: string;
  target: { key: string; type: string; name: string };
  /** plan.md §5 fact classes: explicit / frontmatter (deterministic) / inferred (LLM) / curated, plus code (#236). */
  extractor: 'explicit' | 'frontmatter' | 'inferred' | 'curated' | 'code' | 'spec';
  confidence: number;
  /** Inferred facts carry their source span (plan.md §5). */
  sourceChunkId?: string;
  snippet?: string;
  /**
   * Whether the edge belongs to the live projection (#83). Only meaningful
   * for revision-scoped classes (frontmatter / inferred / spec); explicit and
   * curated edges are document-level and always live. Defaults to true.
   */
  live?: boolean;
  /**
   * The row's time axes (#81), carried over when an edge is re-keyed
   * (`mergeEntityKey`). Omitted on a fresh write: it is ingested now, and a
   * document-level edge is valid from now on.
   */
  temporal?: EdgeTemporal;
}

/**
 * The two time axes of an edge row (#81), epoch ms. Valid time is the KB's
 * history, stamped from PG revision times (`stampRevisions`); system time is
 * when we wrote and stopped believing the row. Null `validFrom` is a row the
 * backfill has not reached yet, or a branch lineage.
 */
export interface EdgeTemporal {
  validFrom: number | null;
  validTo: number | null;
  ingestedAt: number | null;
  expiredAt: number | null;
  /** `extractor` (re-extraction dropped it) or `user:<id>` (a person retracted it). */
  retractedBy: string | null;
  lineage: Lineage | null;
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
  /** False for edges of a retired revision; legacy rows read as live. */
  live: boolean;
  temporal: EdgeTemporal;
}

/** A revision's facts of one revision-scoped class, replaced whole. */
export interface RevisionFactsInput {
  workspaceId: string;
  documentId: string;
  revisionId: string;
  title: string;
  facts: FactInput[];
  /** Part of the live projection (#83) — see `upsertRevisionChunks`. */
  live: boolean;
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

  constructor(
    private readonly arcade: ArcadeClient,
    private readonly aliases: EntityAliasService,
  ) {}

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

    // Tolerating each statement individually is right — but tolerating ALL of
    // them is not. Verify the result instead of trusting it: if the types are
    // absent the worker cannot index anything, and without this check that
    // surfaces hours later as an endless stream of jobs failing on "Type with
    // name 'Chunk' was not found", with the real cause (a 403 at boot) already
    // scrolled out of the logs. Throwing here fails onModuleInit, so the worker
    // refuses to start rather than pretending to work.
    const REQUIRED_TYPES = ['Document', 'DocumentRevision', 'Chunk', 'Entity', 'HAS_REVISION', 'HAS_CHUNK'];
    const existing = new Set(
      (await this.arcade.query<{ name?: string }>('sql', 'select from schema:types'))
        .map((t) => t.name)
        .filter((n): n is string => typeof n === 'string'),
    );
    const missing = REQUIRED_TYPES.filter((t) => !existing.has(t));
    if (missing.length > 0) {
      throw new Error(
        `ArcadeDB schema bootstrap failed: missing ${missing.join(', ')}. ` +
          'Every CREATE above was rejected. The usual cause is permissions, not the DDL: ArcadeDB answers 403 ' +
          "\"User is not allowed to update schema\" when ARCADE_USER has no admin group ON THIS DATABASE — a " +
          'database-scoped entry with a null group silently shadows a server-wide {"*":["admin"]}. See the ' +
          'defaultDatabases note in docker-compose.prod.yml; the group is the third bracket element.',
      );
    }
  }

  /**
   * Idempotent (re)index of a revision: previous chunks for the revision are
   * dropped, then the Document/Revision vertices and chunk vertices+edges are
   * recreated. Safe to run on BullMQ retries.
   *
   * `live` stamps the chunks as part of the live projection (#83): true only
   * for the head of the document's default branch. A non-live revision's
   * chunks are still written — the MR diff and `revisionEmbeddingShift` read
   * them by revision id — but no workspace-wide read returns them.
   *
   * `aclNodes` is the page's `restricted_by` as indexing read it (#76), stamped
   * on the Document vertex and every chunk. A stamp only prefilters: reads are
   * decided by the `DocumentAclFilter` read from PG, and `AclRestampSweeper`
   * rewrites the stamps whenever `restricted_by` changes afterwards.
   */
  async upsertRevisionChunks(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    title: string;
    chunks: ChunkInput[];
    live: boolean;
    aclNodes: string[];
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title, chunks, live, aclNodes } = input;
    const aclRestricted = aclNodes.length > 0;

    await this.arcade.command('sql', 'DELETE FROM Chunk WHERE revisionId = :revisionId', { revisionId });
    await this.arcade.command('sql', 'DELETE FROM DocumentRevision WHERE revisionId = :revisionId', { revisionId });

    await this.arcade.command(
      'sql',
      'UPDATE Document SET documentId = :documentId, workspaceId = :workspaceId, title = :title, aclNodes = :aclNodes, aclRestricted = :aclRestricted UPSERT WHERE documentId = :documentId',
      { documentId, workspaceId, title, aclNodes, aclRestricted },
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
         documentId = :documentId, revisionId = :revisionId, live = :live, text = :text,
         headingPath = :headingPath, embedding = :embedding, aclNodes = :aclNodes, aclRestricted = :aclRestricted`,
        {
          chunkId: chunk.chunkId,
          idx: chunk.index,
          workspaceId,
          documentId,
          revisionId,
          live,
          text: chunk.text,
          headingPath: chunk.headingPath,
          embedding: chunk.embedding,
          aclNodes,
          aclRestricted,
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
   * A revision's chunks in full, as written, for re-mirroring them into the
   * BM25 index after a failed write (#173). Reading what the graph holds rather
   * than re-chunking the source keeps the chunk ids the two stores fuse on in
   * step, whatever the chunker has become since.
   */
  async getRevisionChunkTexts(
    workspaceId: string,
    revisionId: string,
  ): Promise<Array<{ chunkId: string; documentId: string; index: number; text: string; headingPath: string[] }>> {
    const rows = await this.arcade.query<{ chunkId: string; documentId: string; idx: number; text: string; headingPath: string[] }>(
      'sql',
      'SELECT chunkId, documentId, idx, text, headingPath FROM Chunk WHERE workspaceId = :workspaceId AND revisionId = :revisionId ORDER BY idx',
      { workspaceId, revisionId },
    );
    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      index: r.idx,
      text: r.text ?? '',
      headingPath: r.headingPath ?? [],
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

  /**
   * The mean chunk embedding of each revision (#74, the auditor's duplicate
   * check), one read per batch rather than one per page. A revision with no
   * indexed chunks is absent from the map. Raw vectors stay in the graph
   * layer's callers only as means — never a chunk's own vector.
   */
  async meanRevisionEmbeddings(workspaceId: string, revisionIds: readonly string[]): Promise<Map<string, number[]>> {
    const sums = new Map<string, { sum: number[]; n: number }>();
    for (let at = 0; at < revisionIds.length; at += MEAN_BATCH) {
      const batch = revisionIds.slice(at, at + MEAN_BATCH);
      const rows = await this.arcade.query<{ revisionId: string; embedding: number[] }>(
        'sql',
        `SELECT revisionId, embedding FROM Chunk WHERE workspaceId = :workspaceId AND revisionId IN :revisionIds LIMIT ${CHUNK_SCAN_LIMIT}`,
        { workspaceId, revisionIds: [...batch] },
      );
      if (rows.length >= CHUNK_SCAN_LIMIT) this.logger.error(`Mean embeddings hit the ${CHUNK_SCAN_LIMIT}-chunk scan cap; some pages are averaged over part of their chunks.`);
      for (const r of rows) {
        if (!Array.isArray(r.embedding) || r.embedding.length === 0) continue;
        const acc = sums.get(r.revisionId);
        if (!acc) sums.set(r.revisionId, { sum: [...r.embedding], n: 1 });
        else if (acc.sum.length === r.embedding.length) {
          for (let i = 0; i < acc.sum.length; i++) acc.sum[i] += r.embedding[i];
          acc.n += 1;
        }
      }
    }
    return new Map([...sums].map(([id, { sum, n }]) => [id, sum.map((v) => v / n)]));
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
   * Rewrite a page's `aclNodes` stamps on its Document vertex and every chunk
   * of every revision (#76), after its `restricted_by` changed. Stamps only —
   * nothing is re-embedded or re-chunked.
   */
  async restampDocument(workspaceId: string, documentId: string, aclNodes: string[]): Promise<void> {
    const params = { workspaceId, documentId, aclNodes, aclRestricted: aclNodes.length > 0 };
    for (const type of ['Document', 'Chunk']) {
      await this.arcade.command(
        'sql',
        `UPDATE ${type} SET aclNodes = :aclNodes, aclRestricted = :aclRestricted WHERE workspaceId = :workspaceId AND documentId = :documentId`,
        params,
      );
    }
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
  async replaceRevisionFrontmatterFacts(input: RevisionFactsInput): Promise<void> {
    await this.replaceRevisionScopedFacts('frontmatter', input);
  }

  /**
   * Idempotent replace of an API spec revision's `DESCRIBES` edges to its
   * operations and channels (#78). Deterministic like frontmatter, and its own
   * class so neither replace wipes the other's edges on the same revision.
   */
  async replaceRevisionSpecFacts(input: RevisionFactsInput): Promise<void> {
    await this.replaceRevisionScopedFacts('spec', input);
  }

  private async replaceRevisionScopedFacts(
    extractor: 'frontmatter' | 'spec',
    input: RevisionFactsInput,
  ): Promise<void> {
    const facts = await this.canonicalFacts(input.workspaceId, input.facts);
    await this.reconcileRevisionFacts(extractor, input, facts);
  }

  /**
   * Bring one revision's edges of one extractor in line with `facts` (#81).
   * The first index of a revision only creates. A re-index of the same
   * revision (embedding drift, dependent reindex) keeps re-asserted facts in
   * place, creates new ones, and EXPIRES dropped ones rather than deleting
   * them: the page did not change, our belief did, and `knownAt` must still be
   * able to say what we believed before. Valid time is not touched here — the
   * processor stamps it from PG afterwards (`stampRevisions`).
   */
  private async reconcileRevisionFacts(
    extractor: 'frontmatter' | 'spec' | 'inferred',
    input: RevisionFactsInput,
    facts: FactInput[],
  ): Promise<void> {
    const { workspaceId, documentId, revisionId, title, live } = input;
    const scope = 'workspaceId = :workspaceId AND documentId = :documentId AND revisionId = :revisionId AND extractor = :extractor';
    const existing: ExistingFactRow[] = [];
    for (const type of RELATION_EDGE_TYPES) {
      const rows = await this.arcade
        .query<{ targetKey: string; expiredAt?: number | null }>('sql', `SELECT targetKey, expiredAt FROM ${type} WHERE ${scope}`, {
          workspaceId,
          documentId,
          revisionId,
          extractor,
        })
        .catch(() => []);
      for (const r of rows) existing.push({ type, targetKey: r.targetKey, expiredAt: r.expiredAt ?? null });
    }
    const { keep, expire, create } = diffRevisionFacts(existing, facts);
    const now = Date.now();

    for (const row of expire) {
      await this.arcade.command(
        'sql',
        `UPDATE ${row.type} SET expiredAt = :now, retractedBy = 'extractor', live = false WHERE ${scope} AND targetKey = :targetKey AND expiredAt IS NULL`,
        { workspaceId, documentId, revisionId, extractor, targetKey: row.targetKey, now },
      );
    }
    for (const fact of keep) {
      await this.arcade.command(
        'sql',
        `UPDATE ${fact.type} SET confidence = :confidence, sourceChunkId = :sourceChunkId, snippet = :snippet, live = :live WHERE ${scope} AND targetKey = :targetKey AND expiredAt IS NULL`,
        {
          workspaceId,
          documentId,
          revisionId,
          extractor,
          targetKey: fact.target.key,
          confidence: fact.confidence,
          sourceChunkId: fact.sourceChunkId ?? null,
          snippet: fact.snippet ?? null,
          live,
        },
      );
    }
    if (create.length === 0) return;
    await this.upsertDocumentVertex(workspaceId, documentId, title);
    for (const fact of create) {
      await this.createRelationEdge(workspaceId, documentId, revisionId, { ...fact, live });
    }
  }

  /**
   * Write the valid-time stamps (#81) onto each revision's chunks and
   * revision-scoped edges. The stamps come from `revisionStamps` over the PG
   * revision list, so this is idempotent and order-free: the processor
   * rewrites the window around the revision it just indexed, the backfill
   * rewrites them all. Document-level edges (explicit, curated, code) carry
   * their own valid time from the moment they were written.
   */
  async stampRevisions(workspaceId: string, documentId: string, stamps: readonly RevisionStamp[]): Promise<void> {
    const scope = 'workspaceId = :workspaceId AND documentId = :documentId AND revisionId = :revisionId';
    const set = 'SET validFrom = :validFrom, validTo = :validTo, lineage = :lineage';
    for (const stamp of stamps) {
      const params = { workspaceId, documentId, ...stamp };
      await this.arcade.command('sql', `UPDATE Chunk ${set} WHERE ${scope}`, params);
      for (const type of RELATION_EDGE_TYPES) {
        await this.arcade.command('sql', `UPDATE ${type} ${set} WHERE ${scope} AND ${SCOPED_SQL}`, params).catch(() => {
          /* edge type may hold no rows yet */
        });
      }
    }
  }

  /**
   * Make `liveRevisionId` the document's live projection (#83): its chunks and
   * revision-scoped edges (frontmatter / inferred) become live, every other
   * revision's become history. Explicit and curated edges are document-level
   * and untouched.
   *
   * Stamps rather than deletes: a branch revision's chunks and edges are what
   * the MR diff and `revisionEmbeddingShift` read, by revision id, and they
   * must survive the page's head moving on.
   *
   * The new revision is raised before the old ones are lowered, so a
   * concurrent read sees a duplicate for a moment rather than a missing page.
   * Idempotent — the ingestion processor calls it after every job, whichever
   * revision finished last, so an out-of-order finish still converges on the
   * current head.
   */
  async setLiveRevision(workspaceId: string, documentId: string, liveRevisionId: string | null): Promise<void> {
    // `null` retires the whole document — a page whose default branch has no
    // indexed revision yet has nothing live. No revision id is the empty
    // string, so the raise below matches nothing and the lower matches all.
    const params = { workspaceId, documentId, revisionId: liveRevisionId ?? '' };
    const scope = 'workspaceId = :workspaceId AND documentId = :documentId';

    await this.arcade.command('sql', `UPDATE Chunk SET live = true WHERE ${scope} AND revisionId = :revisionId`, params);
    for (const type of RELATION_EDGE_TYPES) {
      await this.arcade
        // An expired row (#81) is history even on the live revision.
        .command('sql', `UPDATE ${type} SET live = true WHERE ${scope} AND ${SCOPED_SQL} AND revisionId = :revisionId AND expiredAt IS NULL`, params)
        .catch(() => {
          /* edge type may hold no rows yet */
        });
    }

    await this.arcade.command('sql', `UPDATE Chunk SET live = false WHERE ${scope} AND revisionId <> :revisionId`, params);
    for (const type of RELATION_EDGE_TYPES) {
      await this.arcade
        .command('sql', `UPDATE ${type} SET live = false WHERE ${scope} AND ${SCOPED_SQL} AND revisionId <> :revisionId`, params)
        .catch(() => {
          /* edge type may hold no rows yet */
        });
    }
  }

  /**
   * Replace every `code` edge in the workspace (#236): a page documenting a
   * file that imports a declared component `DEPENDS_ON` that component. The
   * edges are derived from the connectors' import indexes, so they are
   * document-level (no revision, always live) and owned by nothing but this
   * method — rebuilt whole after each pull, never edited.
   *
   * Workspace-wide rather than per connector: a usage page and the component
   * it depends on may sit behind different connectors' declarations, and a
   * whole rebuild is a few hundred edges. Two pulls finishing together can
   * leave a duplicate until the next one; nothing reads a code edge's count.
   *
   * `snippet` carries the provenance: the usage files the edge stands for.
   */
  async replaceCodeFacts(input: {
    workspaceId: string;
    edges: Array<{ documentId: string; title: string; componentKey: string; componentName: string; usages: string[] }>;
  }): Promise<number> {
    const { workspaceId } = input;
    // Folded before the DELETE for the reason `canonicalFacts` gives — though
    // this DELETE is by extractor, the keys written must be the canonical ones.
    const facts = await this.canonicalFacts(
      workspaceId,
      input.edges.map((e) => ({
        type: 'DEPENDS_ON',
        // The page's own spelling, or this rebuild would relabel the vertex the
        // component page's DESCRIBES edge named.
        target: { key: normalizeEntityKey(e.componentKey), type: 'component', name: e.componentName },
        extractor: 'code' as const,
        confidence: 1,
        snippet: usageSnippet(e.usages),
      })),
    );
    await this.arcade
      .command('sql', `DELETE FROM DEPENDS_ON WHERE workspaceId = :workspaceId AND extractor = 'code'`, { workspaceId })
      .catch(() => {
        /* the edge type may hold no rows yet */
      });
    const titled = new Set<string>();
    for (const [i, fact] of facts.entries()) {
      const { documentId, title } = input.edges[i];
      if (!titled.has(documentId)) {
        await this.upsertDocumentVertex(workspaceId, documentId, title);
        titled.add(documentId);
      }
      await this.createRelationEdge(workspaceId, documentId, null, fact);
    }
    return facts.length;
  }

  /**
   * Explicit relations from the REST payload; re-posting the same relation
   * replaces it — the previous row is retracted (#81), not deleted.
   * `actor` is the users.id the retraction is attributed to.
   */
  async addExplicitRelations(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string | null;
    title: string;
    facts: FactInput[];
    actor?: string;
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title } = input;
    const facts = await this.canonicalFacts(workspaceId, input.facts);
    if (facts.length === 0) return;
    await this.upsertDocumentVertex(workspaceId, documentId, title);
    for (const fact of facts) {
      this.assertEdgeType(fact.type);
      await this.retract(workspaceId, documentId, fact.type, fact.target.key, ['explicit'], input.actor);
      await this.createRelationEdge(workspaceId, documentId, revisionId, fact);
    }
  }

  /**
   * Retract a document's open edges of `(type, targetKey)` (#81): expired and
   * out of the live projection, attributed to the person, but kept so the
   * facts timeline and `knownAt` can still show them. A document-level edge
   * also stops being valid now — the page's owner withdrew the claim. A
   * revision-scoped edge keeps its PG-stamped valid time: the revision still
   * said it, we just no longer believe it.
   */
  private async retract(
    workspaceId: string,
    documentId: string,
    type: string,
    targetKey: string,
    extractors: readonly string[] | null,
    actor: string | undefined,
  ): Promise<void> {
    const params = {
      workspaceId,
      documentId,
      targetKey,
      now: Date.now(),
      retractedBy: actor ? `user:${actor}` : 'user',
      ...(extractors ? { extractors: [...extractors] } : {}),
    };
    const where = `workspaceId = :workspaceId AND documentId = :documentId AND targetKey = :targetKey AND expiredAt IS NULL${extractors ? ' AND extractor IN :extractors' : ''}`;
    await this.arcade
      .command('sql', `UPDATE ${type} SET validTo = :now WHERE ${where} AND NOT (${SCOPED_SQL})`, params)
      .catch(() => {
        /* edge type may hold no rows yet */
      });
    await this.arcade
      .command('sql', `UPDATE ${type} SET expiredAt = :now, retractedBy = :retractedBy, live = false WHERE ${where}`, params)
      .catch(() => {
        /* edge type may hold no rows yet */
      });
  }

  /**
   * Relation edges of a document, with provenance (workspace-scoped).
   *
   * `liveOnly` (#83) restricts to the live projection — what the page asserts
   * now. Leave it off where revision history is the point: the semantic diff
   * and the facts timeline filter by revision id themselves.
   */
  async getDocumentRelations(
    workspaceId: string,
    documentId: string,
    opts: { liveOnly?: boolean; includeExpired?: boolean } = {},
  ): Promise<DocumentRelation[]> {
    const out: DocumentRelation[] = [];
    const liveClause = opts.liveOnly ? ` AND ${LIVE}` : '';
    for (const type of RELATION_EDGE_TYPES) {
      const rows = await this.arcade
        .query<{ targetKey: string; revisionId: string | null; extractor: string; confidence: number; sourceChunkId?: string | null; snippet?: string | null; live?: boolean | null } & Partial<EdgeTemporal>>(
          'sql',
          `SELECT targetKey, revisionId, extractor, confidence, sourceChunkId, snippet, live, ${TEMPORAL_COLUMNS} FROM ${type} WHERE workspaceId = :workspaceId AND documentId = :documentId${liveClause}`,
          { workspaceId, documentId },
        )
        .catch(() => []);
      for (const r of rows) {
        const temporal = temporalOf(r);
        // Expired rows (#81) are what we stopped believing: only the facts
        // timeline asks for them.
        if (temporal.expiredAt !== null && !opts.includeExpired) continue;
        out.push({ type, targetKey: r.targetKey, entityType: '', name: '', revisionId: r.revisionId ?? null, extractor: r.extractor, confidence: r.confidence, sourceChunkId: r.sourceChunkId ?? undefined, snippet: r.snippet ?? undefined, live: r.live !== false, temporal });
      }
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

  /**
   * Fold every edge pointing at `alias` onto `canonicalKey`, then drop the
   * abandoned vertex. Returns how many edges moved.
   *
   * Declaring an alias only changes what *future* writes resolve to; the ru and
   * en halves already in the graph stay split until something moves them. This
   * is that something, and it runs when the alias is declared rather than on a
   * schedule — there is no cron in this repo, and the moment of declaration is
   * the only moment a new fork becomes resolvable.
   *
   * Read-then-recreate rather than `UPDATE ... SET targetKey`: an edge holds
   * both the denormalized `targetKey` and a real link to the vertex, so setting
   * the column alone would leave the link pointing at a vertex about to be
   * deleted. Going back through `createRelationEdge` keeps one write path, so
   * the edge-type allowlist and the canonical-key assertion still apply.
   * Idempotent: a second run finds no alias-keyed edges and does nothing.
   */
  async mergeEntityKey(workspaceId: string, alias: string, canonicalKey: string): Promise<number> {
    const from = normalizeEntityKey(alias);
    const to = normalizeEntityKey(canonicalKey);
    if (!from || !to || from === to) return 0;

    let moved = 0;
    for (const type of RELATION_EDGE_TYPES) {
      const rows = await this.arcade
        .query<{
          documentId: string;
          revisionId: string | null;
          extractor: FactInput['extractor'];
          confidence: number;
          sourceChunkId?: string | null;
          snippet?: string | null;
          live?: boolean | null;
        } & Partial<EdgeTemporal>>(
          'sql',
          `SELECT documentId, revisionId, extractor, confidence, sourceChunkId, snippet, live, ${TEMPORAL_COLUMNS} FROM ${type} WHERE workspaceId = :workspaceId AND targetKey = :targetKey`,
          { workspaceId, targetKey: from },
        )
        .catch(() => []);
      if (rows.length === 0) continue;

      await this.arcade
        .command('sql', `DELETE FROM ${type} WHERE workspaceId = :workspaceId AND targetKey = :targetKey`, {
          workspaceId,
          targetKey: from,
        })
        .catch(() => {
          /* nothing to move */
        });

      for (const r of rows) {
        await this.createRelationEdge(workspaceId, r.documentId, r.revisionId ?? null, {
          type,
          target: { key: to, type: entityTypeOf(to), name: entityNameOf(to) },
          extractor: r.extractor,
          confidence: r.confidence,
          ...(r.sourceChunkId ? { sourceChunkId: r.sourceChunkId } : {}),
          ...(r.snippet ? { snippet: r.snippet } : {}),
          // A retired edge stays retired, and keeps its history (#81), when
          // its target is re-keyed.
          live: r.live !== false,
          temporal: temporalOf(r),
        });
        moved += 1;
      }
    }

    await this.arcade
      .command('sql', 'DELETE FROM Entity WHERE workspaceId = :workspaceId AND entityKey = :entityKey', {
        workspaceId,
        entityKey: from,
      })
      .catch(() => {
        /* the vertex may never have existed */
      });
    return moved;
  }

  private async createRelationEdge(
    workspaceId: string,
    documentId: string,
    revisionId: string | null,
    fact: FactInput,
  ): Promise<void> {
    this.assertEdgeType(fact.type);
    this.assertCanonicalKey(fact.target.key);
    await this.arcade.command(
      'sql',
      'UPDATE Entity SET entityKey = :key, workspaceId = :workspaceId, entityType = :entityType, name = :name UPSERT WHERE entityKey = :key AND workspaceId = :workspaceId',
      { key: fact.target.key, workspaceId, entityType: fact.target.type, name: fact.target.name },
    );
    await this.arcade.command(
      'sql',
      `CREATE EDGE ${fact.type} FROM (SELECT FROM Document WHERE documentId = :documentId) TO (SELECT FROM Entity WHERE entityKey = :key AND workspaceId = :workspaceId) SET workspaceId = :workspaceId, documentId = :documentId, revisionId = :revisionId, live = :live, targetKey = :key, extractor = :extractor, confidence = :confidence, sourceChunkId = :sourceChunkId, snippet = :snippet, ${TEMPORAL_COLUMNS.split(', ').map((c) => `${c} = :${c}`).join(', ')}`,
      {
        documentId,
        key: fact.target.key,
        workspaceId,
        revisionId,
        live: fact.live ?? true,
        ...(fact.temporal ?? freshTemporal(fact.extractor)),
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
   * Entity keys are folded here, at the one place every write passes through.
   *
   * Callers normalize too, but a caller can forget; this is the recorder, the
   * same role it plays for the mandatory workspace predicate. Note it must run
   * BEFORE the guarded DELETEs in the methods below, not inside
   * `createRelationEdge`: those delete by `targetKey`, so folding only on the
   * way in would leave the delete looking for a key that is no longer written
   * and quietly duplicate an edge on every re-post.
   */
  private async canonicalFacts(workspaceId: string, facts: FactInput[]): Promise<FactInput[]> {
    const keys = await this.aliases.resolveAll(
      workspaceId,
      facts.map((f) => f.target.key),
    );
    return facts.map((f, i) => {
      const key = keys[i];
      if (key === f.target.key) return f;
      // The display name has to follow the key. Left alone, the UPSERT below
      // would let whichever page indexed last stamp "Биллинг" over "Billing"
      // on the vertex they now share.
      return {
        ...f,
        target: { ...f.target, key, type: entityTypeOf(key), name: entityNameOf(key) },
      };
    });
  }

  /**
   * A key that reached the edge writer un-folded is a fork in the making, and
   * the index will not complain — it will happily hold both spellings. Fail
   * loudly instead, so a write path added later is caught on its first run.
   */
  private assertCanonicalKey(key: string): void {
    if (key !== normalizeEntityKey(key)) {
      throw new Error(`Entity key ${key} reached the graph un-normalized`);
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
    /** Part of the live projection (#83) — see `upsertRevisionChunks`. */
    live: boolean;
  }): Promise<void> {
    const facts = await this.canonicalFacts(input.workspaceId, input.facts);
    const protectedPairs = new Set<string>();
    if (facts.length > 0) {
      // Retracted curated/explicit rows are not read (#81): a withdrawn claim
      // protects nothing.
      for (const rel of await this.getDocumentRelations(input.workspaceId, input.documentId)) {
        if (rel.extractor === 'curated' || rel.extractor === 'explicit') {
          protectedPairs.add(`${rel.type} ${rel.targetKey}`);
        }
      }
    }
    await this.reconcileRevisionFacts(
      'inferred',
      input,
      facts.filter((f) => !protectedPairs.has(`${f.type} ${f.target.key}`)),
    );
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
    /** users.id the retraction of the replaced edge is attributed to (#81). */
    actor?: string;
  }): Promise<void> {
    const { workspaceId, documentId, revisionId, title } = input;
    const [fact] = await this.canonicalFacts(workspaceId, [input.fact]);
    this.assertEdgeType(fact.type);
    await this.retract(workspaceId, documentId, fact.type, fact.target.key, ['inferred', 'curated'], input.actor);
    await this.upsertDocumentVertex(workspaceId, documentId, title);
    await this.createRelationEdge(workspaceId, documentId, revisionId, { ...fact, extractor: 'curated', confidence: 1 });
  }

  /**
   * Retract a document's relation edges by (type, target), optionally one fact
   * class only (#81): they leave every current view but stay in the facts
   * timeline, attributed to `actor`. Only `deleteDocumentGraph` erases.
   */
  async deleteRelations(
    workspaceId: string,
    documentId: string,
    type: string,
    targetKey: string,
    extractor?: string,
    actor?: string,
  ): Promise<void> {
    this.assertEdgeType(type);
    // Fold here too: edges are stored under the canonical key, so a delete for
    // the spelling the caller happens to hold would silently match nothing.
    await this.retract(workspaceId, documentId, type, normalizeEntityKey(targetKey), extractor ? [extractor] : null, actor);
  }

  /**
   * Document ids carrying ANY of the given tag entity keys (`tag:<name>`), for
   * the search tag filter. Deliberately narrow: the full relation graph is a
   * query per edge type, far too much work to answer "which docs have tag X",
   * and the tag filter must also work in semantic/keyword mode where the
   * expansion graph is never loaded.
   *
   * `acl` (#76) keeps out pages the reader may not open.
   */
  async getDocumentIdsByTags(workspaceId: string, tagKeys: string[], acl: DocumentAclFilter): Promise<Set<string>> {
    if (tagKeys.length === 0) return new Set();
    const pushed = aclClause(acl);
    const rows = await this.arcade
      .query<{ documentId: string }>(
        'sql',
        `SELECT documentId FROM TAGGED_WITH WHERE workspaceId = :workspaceId AND targetKey IN :keys AND ${LIVE}${pushed?.sql ?? ''} LIMIT 20000`,
        { workspaceId, keys: tagKeys, ...pushed?.params },
      )
      // ArcadeDB throws when the edge type holds no rows yet; "no tag edges"
      // must mean "no matches", not a 500.
      .catch(() => []);
    return new Set(rows.map((r) => r.documentId).filter((id) => aclAdmits(acl, id)));
  }

  /**
   * The workspace's full relation graph (edges + node labels) for Phase 4
   * traversal. Small-scale by design — BFS happens in Node, mirroring the
   * cosine-in-Node search approach; swap for native traversal later.
   *
   * `acl` (#76): pages the reader may not open are not nodes, their edges go,
   * and so does every entity no remaining edge mentions — a restricted page
   * must not leak the names it introduces through the graph view, entity
   * lists or search's graph expansion. With nothing hidden (`all`) the graph
   * is returned as it always was, entities without live edges included.
   */
  async getWorkspaceRelationGraph(workspaceId: string, acl: DocumentAclFilter): Promise<WorkspaceRelationGraph> {
    const pushed = aclClause(acl);
    const where = `workspaceId = :workspaceId${pushed?.sql ?? ''}`;
    const params = { workspaceId, ...pushed?.params };
    const edges: WorkspaceRelationGraph['edges'] = [];
    for (const type of RELATION_EDGE_TYPES) {
      const rows = await this.arcade
        .query<{ documentId: string; targetKey: string; extractor: string; confidence: number }>(
          'sql',
          `SELECT documentId, targetKey, extractor, confidence FROM ${type} WHERE ${where} AND ${LIVE} LIMIT 20000`,
          params,
        )
        .catch(() => []);
      for (const r of rows) {
        if (!aclAdmits(acl, r.documentId)) continue;
        edges.push({ type, documentId: r.documentId, targetKey: r.targetKey, extractor: r.extractor, confidence: r.confidence });
      }
    }

    const docs = await this.arcade.query<{ documentId: string; title: string }>(
      'sql',
      `SELECT documentId, title FROM Document WHERE ${where} LIMIT 20000`,
      params,
    );
    const ents = await this.arcade.query<{ entityKey: string; entityType: string; name: string }>(
      'sql',
      'SELECT entityKey, entityType, name FROM Entity WHERE workspaceId = :workspaceId LIMIT 20000',
      { workspaceId },
    );
    const mentioned = acl.kind === 'all' ? null : new Set(edges.map((e) => e.targetKey));
    return {
      edges,
      documents: Object.fromEntries(
        docs.filter((d) => aclAdmits(acl, d.documentId)).map((d) => [d.documentId, { title: d.title }]),
      ),
      entities: Object.fromEntries(
        ents
          .filter((e) => !mentioned || mentioned.has(e.entityKey))
          .map((e) => [e.entityKey, { type: e.entityType, name: e.name }]),
      ),
    };
  }

  /**
   * Phase 1 semantic search: fetch workspace-scoped chunks and rank by cosine
   * similarity in Node. Swap the body for ArcadeDB HNSW later — same signature.
   *
   * `acl` (#76) keeps out chunks of pages the reader may not open — in the
   * query when the list is short enough, so the scan cap counts only what
   * they may see, otherwise before ranking.
   */
  async searchChunks(workspaceId: string, queryEmbedding: number[], k: number, acl: DocumentAclFilter): Promise<ChunkHit[]> {
    const pushed = aclClause(acl);
    const rows = await this.arcade.query<{
      chunkId: string;
      documentId: string;
      revisionId: string;
      text: string;
      headingPath: string[];
      embedding: number[];
    }>(
      'sql',
      `SELECT chunkId, documentId, revisionId, text, headingPath, embedding FROM Chunk WHERE workspaceId = :workspaceId AND ${LIVE}${pushed?.sql ?? ''} LIMIT ${CHUNK_SCAN_LIMIT}`,
      { workspaceId, ...pushed?.params },
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
      .filter((r) => aclAdmits(acl, r.documentId))
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
   * Every live chunk of a workspace with its stored vector, unranked — the
   * corpus `searchChunks` scans, handed over whole so the capture calibration
   * backtest (#234) can score many probes against one read instead of one
   * full scan per probe. Same scan cap, same ACL pushdown.
   */
  async liveChunks(workspaceId: string, acl: DocumentAclFilter): Promise<StoredChunk[]> {
    const pushed = aclClause(acl);
    const rows = await this.arcade.query<StoredChunk>(
      'sql',
      `SELECT chunkId, documentId, idx, text, headingPath, embedding FROM Chunk WHERE workspaceId = :workspaceId AND ${LIVE}${pushed?.sql ?? ''} LIMIT ${CHUNK_SCAN_LIMIT}`,
      { workspaceId, ...pushed?.params },
    );
    if (rows.length >= CHUNK_SCAN_LIMIT) this.logger.error(`Workspace ${workspaceId} has at least ${CHUNK_SCAN_LIMIT} chunks — the scan cap.`);
    return rows
      .filter((r) => aclAdmits(acl, r.documentId) && Array.isArray(r.embedding))
      .map((r) => ({ ...r, idx: r.idx ?? 0, text: r.text ?? '', headingPath: r.headingPath ?? [] }));
  }

  /**
   * Semantic search over the chunks of the given revisions only, live or not —
   * a published version pins revisions that may since have become history
   * (issue #77 phase 3, a site's Ask). The caller owns the list, so nothing
   * outside it can rank; the workspace predicate still applies.
   */
  async searchRevisionChunks(workspaceId: string, revisionIds: readonly string[], queryEmbedding: number[], k: number): Promise<ChunkHit[]> {
    if (!revisionIds.length) return [];
    const rows = await this.arcade.query<{
      chunkId: string;
      documentId: string;
      revisionId: string;
      text: string;
      headingPath: string[];
      embedding: number[];
    }>(
      'sql',
      `SELECT chunkId, documentId, revisionId, text, headingPath, embedding FROM Chunk WHERE workspaceId = :workspaceId AND revisionId IN :revisionIds LIMIT ${CHUNK_SCAN_LIMIT}`,
      { workspaceId, revisionIds: [...revisionIds] },
    );
    if (rows.length >= CHUNK_SCAN_LIMIT) {
      this.logger.error(`Revision-scoped vector search hit the ${CHUNK_SCAN_LIMIT}-chunk scan cap; ranking an arbitrary subset.`);
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

export function cosine(a: number[], b: number[]): number {
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
