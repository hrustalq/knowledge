import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  DocumentTrust,
  RelatedDocumentResult,
  SearchDegradedLeg,
  SearchResponse,
  SearchResult,
} from '@knowledge/contracts';
import { isInactive, trustWeight, verificationStateFor } from '@knowledge/contracts';
import { currentTrace, emitBacktest } from '@knowledge/observability';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { DocumentAclFilter } from '../common/document-acl.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { GraphService, type ChunkHit } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { FULLTEXT_PROVIDER, type FulltextHit, type FulltextProvider } from '../fulltext/fulltext.provider.js';
import { ProvenanceService } from '../feedback/provenance.service.js';
import { VerificationPolicyService } from '../verification/verification-policy.service.js';
import { tagFilterKey } from '../common/relations.js';
import type { TemporalPoint } from '../graph/temporal.js';
import { loadRevisionStamps } from '../graph/revision-stamps.js';
import { TemporalResolverService } from '../temporal/temporal-resolver.service.js';
import type { SearchDto } from './search.dto.js';

/** Reciprocal-rank-fusion constant (standard k=60). */
const RRF_K = 60;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  /** Set while the BM25 leg is failing, so an outage logs once, not once per search. */
  private fulltextDownSince: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(FULLTEXT_PROVIDER) private readonly fulltext: FulltextProvider,
    private readonly provenance: ProvenanceService,
    private readonly policy: VerificationPolicyService,
    private readonly permissions: PermissionService,
    private readonly config: ConfigService<Env, true>,
    private readonly temporal: TemporalResolverService,
  ) {}

  /**
   * `scope` is required (#76): every hit, related page and entity returned is
   * one the caller may open. The stores apply the scope's page list as a
   * predicate where they can; the PG join below applies the predicate itself
   * and is the one that decides.
   */
  async search(dto: SearchDto, scope: AccessScope): Promise<SearchResponse> {
    const mode = dto.mode ?? 'hybrid';
    const k = dto.limit ?? 20;
    // Feature 02: with any metadata filter (category, project or tag),
    // over-fetch candidates so the filter does not shrink the requested limit.
    const categories = dto.filters?.categories?.length ? new Set(dto.filters.categories) : null;
    const projectIds = dto.filters?.projectIds?.length ? new Set(dto.filters.projectIds) : null;
    // Tags live in the graph, not PG: frontmatter `tags:` become TAGGED_WITH
    // edges to `tag:<name>` entities. Accept either form so callers can pass
    // the entity key straight back from GET /v1/entities.
    const tagKeys = dto.filters?.tags?.length
      ? [...new Set(dto.filters.tags.map(tagFilterKey))]
      : null;
    const states = dto.filters?.verificationStates?.length ? new Set(dto.filters.verificationStates) : null;
    const includeArchived = dto.filters?.includeArchived === true;
    // Trust re-rank (docs/features/39): env kill switch × workspace override.
    // When it is on, candidates are at least doubled so a demoted hit has
    // something to be displaced by; when it is off, fetchK is exactly what it
    // was before #66, because RRF over a longer candidate list is a different
    // ranking and "off" promises the old one.
    // #81: `asOf` searches the text each page held then, under the same
    // filters; the trust re-rank and the PG join still read the page as it is.
    const [settings, acl, at] = await Promise.all([
      this.policy.effective(dto.workspaceId),
      this.permissions.documentFilterFor(scope),
      this.temporal.resolve(dto.workspaceId, dto.asOf, dto.knownAt),
    ]);
    const trustOn = settings.trustRanking;
    const filtered = categories || projectIds || tagKeys || states;
    // When the stores could not take the caller's page list as a predicate
    // (past ACL_DENY_LIST_MAX), the post-filter below is what drops their
    // hidden pages — over-fetch for that as for any other filter.
    const aclPostOnly = acl.kind !== 'all' && !acl.pushdown;
    const aclOverfetch = aclPostOnly ? this.config.get('SEARCH_ACL_OVERFETCH', { infer: true }) : 1;
    let fetchK = Math.max(filtered ? k * 5 : k, trustOn ? k * 2 : k, k * aclOverfetch);

    // Phase 5 BM25 layer (plan.md §11): when a fulltext provider is
    // configured, 'hybrid' fuses vector + BM25 rankings (RRF) and 'keyword'
    // is BM25-only. Without a provider both fall back to vector search.
    // Mutable (#173): a BM25 leg that fails is dropped for the rest of this
    // search, and 'keyword' then stands on the vector leg rather than on nothing.
    let useText = this.fulltext.enabled && mode !== 'semantic';
    let useVector = mode !== 'keyword' || !this.fulltext.enabled;
    const degraded: SearchDegradedLeg[] = [];

    const startedAt = process.hrtime.bigint();
    const since = (from: bigint) => Number(process.hrtime.bigint() - from) / 1e6;
    // Per-leg, not just total: a retrieval regression is almost always in one
    // leg, and a single duration cannot tell a slow embedder from a slow BM25
    // index from a graph walk. The legs run concurrently, so these overlap.
    const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
      const at = process.hrtime.bigint();
      const value = await fn();
      return [value, since(at)];
    };

    // The query embedding is computed once and reused by a refill round.
    let embedding: Promise<number[]> | null = null;
    const vectorLeg = (n: number) =>
      (embedding ??= this.embeddings.embed(dto.query)).then((e) => this.graph.searchChunks(dto.workspaceId, e, n, acl, at));
    /**
     * Both legs, concurrently. The vector index is authoritative and the BM25
     * one optional (docs/architecture/04), so a failed or slow BM25 leg is
     * answered without, not thrown (#173): the search goes vector-only, says so
     * in `degraded`, and a keyword search runs the vector leg it skipped.
     */
    const legs = async (n: number): Promise<[[ChunkHit[], number], [FulltextHit[], number]]> => {
      const [vector, [text, textMs]] = await Promise.all([
        timed(() => (useVector ? vectorLeg(n) : Promise.resolve([] as ChunkHit[]))),
        timed(() => (useText ? this.fulltextLeg(dto.workspaceId, dto.query, n, acl, at) : Promise.resolve([]))),
      ]);
      if (text) return [vector, [text, textMs]];
      useText = false;
      degraded.push('fulltext');
      if (useVector) return [vector, [[], textMs]];
      useVector = true;
      return [await timed(() => vectorLeg(n)), [[], textMs]];
    };

    const [[[vectorHitsFirst, vectorMs], [textHitsFirst, fulltextMs]], [taggedDocs, tagsMs]] = await Promise.all([
      legs(fetchK),
      // Overlaps the embedding round-trip rather than serializing after it.
      timed(() => (tagKeys ? this.graph.getDocumentIdsByTags(dto.workspaceId, tagKeys, acl, at) : Promise.resolve(null))),
    ]);
    let vectorHits = vectorHitsFirst;
    let textHits = textHitsFirst;
    let hits = this.fuse(vectorHits, textHits, fetchK);
    let aclFiltered = 0;

    /**
     * The measurement a recall@k / MRR sweep replays.
     *
     * Recorded at every exit including the empty one — "this query returned
     * nothing" is a data point the September backtest was built to count, and a
     * harness that only sees successful searches overstates recall.
     */
    const record = (out: SearchResult[]): void => {
      const trace = currentTrace();
      emitBacktest({
        ...(trace ?? { traceId: 'unscoped', source: 'cli' as const }),
        workspaceId: dto.workspaceId,
        kind: 'search.executed',
        ts: new Date().toISOString(),
        durationMs: since(startedAt),
        query: dto.query,
        mode,
        limit: k,
        fetchK,
        vectorMs: useVector ? vectorMs : undefined,
        fulltextMs: useText || degraded.length ? fulltextMs : undefined,
        tagsMs: tagKeys ? tagsMs : undefined,
        vectorHits: vectorHits.length,
        fulltextHits: textHits.length,
        fusedHits: hits.length,
        trustApplied: trustOn,
        ...(acl.kind !== 'all' ? { aclFiltered } : {}),
        ...(degraded.length ? { degraded } : {}),
        ...(at ? { asOf: dto.asOf ?? 'now' } : {}),
        results: out.map((r) => ({ documentId: r.documentId, chunkId: r.chunkId, score: r.score })),
      });
    };

    // Absent unless a leg was skipped, so a healthy response is unchanged.
    const health = () => ({ ...(degraded.length ? { degraded } : {}), ...(at ? { resolvedAsOf: at.resolved } : {}) });

    if (hits.length === 0) {
      record([]);
      return { results: [], ...health() };
    }

    // Join PG for authoritative titles (three-store separation: PG owns
    // metadata), for everything the trust re-rank reads — the stamp, the flag,
    // the owner, the freshness clock and the archive mark — and for the
    // page-permission predicate itself (#76). The stores' filter came from a
    // list read a moment earlier; this is the read that decides.
    // A hit is kept only if this read returns its page, for every reader: a
    // page gone from PG can leave chunks behind in a store, and those must not
    // outrank real answers as "(unknown)" for whoever happens to hide nothing.
    const visibleHits = async (candidates: ChunkHit[]) => {
      const docIds = [...new Set(candidates.map((h) => h.documentId))];
      const docs = await this.loadDocs(docIds, scope);
      const seen = new Set(docs.map((d) => d.id));
      return { docs, kept: candidates.filter((h) => seen.has(h.documentId)) };
    };
    let { docs, kept } = await visibleHits(hits);
    aclFiltered = hits.length - kept.length;

    // One refill round (#76): the post-filter dropped hits, left fewer than k,
    // and a leg came back full — so it had more to give. Bounded by
    // SEARCH_ACL_MAX_FETCH, and only ever once.
    const maxFetch = this.config.get('SEARCH_ACL_MAX_FETCH', { infer: true });
    const saturated = vectorHits.length >= fetchK || textHits.length >= fetchK;
    if (aclFiltered > 0 && kept.length < k && saturated && fetchK < maxFetch) {
      fetchK = Math.min(fetchK * 2, maxFetch);
      [[vectorHits], [textHits]] = await legs(fetchK);
      hits = this.fuse(vectorHits, textHits, fetchK);
      ({ docs, kept } = await visibleHits(hits));
      aclFiltered = hits.length - kept.length;
    }

    const docIds = docs.map((d) => d.id);
    const issues = await this.provenance.openIssueCounts(docIds);
    const docById = new Map(docs.map((d) => [d.id, d]));
    const now = new Date();
    const trustOf = new Map<string, DocumentTrust>();
    for (const d of docs) {
      const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
      trustOf.set(d.id, {
        status: verificationStateFor(d, headId, issues.get(d.id) ?? 0, now),
        verifiedAt: d.verifiedAt?.toISOString() ?? null,
        expiresAt: d.verificationExpiresAt?.toISOString() ?? null,
        ownerId: d.ownerId,
        inactive: isInactive(d.lastActivityAt, settings.inactiveAfterDays, now),
      });
    }

    // Archived pages drop first, whatever the switch says: they are put away,
    // not demoted. Then the multiplicative weight, a re-sort, and only then
    // the cut to k — the weight is the point of the over-fetch above.
    const weighted = kept
      .filter((h) => includeArchived || !docById.get(h.documentId)?.archivedAt)
      .filter((h) => !taggedDocs || taggedDocs.has(h.documentId))
      .filter((h) => !categories || categories.has((docById.get(h.documentId)?.category ?? 'other') as never))
      .filter((h) => !projectIds || projectIds.has(docById.get(h.documentId)?.projectId ?? ''))
      .filter((h) => !states || states.has(trustOf.get(h.documentId)?.status ?? 'unverified'))
      .map((h) => {
        const trust = trustOf.get(h.documentId);
        const weight = trustOn && trust ? trustWeight(trust.status, trust.inactive) : 1;
        return { hit: h, score: h.score * weight, trust };
      });
    if (trustOn) weighted.sort((a, b) => b.score - a.score);

    const results: SearchResult[] = weighted.slice(0, k).map(({ hit: h, score, trust }) => ({
      documentId: h.documentId,
      revisionId: h.revisionId,
      chunkId: h.chunkId,
      title: docById.get(h.documentId)?.title ?? '(unknown)',
      snippet: h.text.slice(0, 300),
      score: Number(score.toFixed(4)),
      headingPath: h.headingPath ?? [],
      ...(trust ? { trust } : {}),
    }));
    if (at) await this.attachValidity(results);

    record(results);

    // Phase 4 hybrid mode: vectors find evidence, the graph expands it
    // (plan.md §12.7). Walk relation edges out from the hit documents.
    if (mode === 'hybrid' && dto.expandGraph) {
      const related = await this.expandGraph(
        scope,
        acl,
        results,
        Math.min(dto.expandGraph.depth ?? 1, 3),
        dto.expandGraph.relationTypes,
        includeArchived,
        at,
      );
      return { results, related, ...health() };
    }
    return { results, ...health() };
  }

  /**
   * The BM25 leg with its own deadline, or `null` when it failed or ran past
   * FULLTEXT_TIMEOUT_MS (#173). A hung index cannot hold the request; the call
   * it raced keeps running and its answer is dropped.
   *
   * Logged once per outage and once on recovery: an OpenSearch restart fails
   * every search for a minute, and a warning per request would bury the cause.
   */
  private async fulltextLeg(
    workspaceId: string,
    query: string,
    k: number,
    acl: DocumentAclFilter,
    at?: TemporalPoint,
  ): Promise<FulltextHit[] | null> {
    const ms = this.config.get('FULLTEXT_TIMEOUT_MS', { infer: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const hits = await Promise.race([
        this.fulltext.search(workspaceId, query, k, acl, at),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
        }),
      ]);
      if (this.fulltextDownSince) {
        this.logger.log(`Fulltext search recovered after an outage since ${this.fulltextDownSince.toISOString()}`);
        this.fulltextDownSince = null;
      }
      return hits;
    } catch (e) {
      if (!this.fulltextDownSince) {
        this.fulltextDownSince = new Date();
        this.logger.warn({
          msg: 'Fulltext search failed; answering from vectors alone until it recovers',
          code: 'FULLTEXT_DEGRADED',
          err: e,
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * When each hit's text was its page's content (#81), from the same PG
   * stamps the graph carries. One read per page in the results, so at most k.
   */
  private async attachValidity(results: SearchResult[]): Promise<void> {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const byRevision = new Map(
      (await Promise.all([...new Set(results.map((r) => r.documentId))].map((id) => loadRevisionStamps(this.prisma, id))))
        .flat()
        .map((s) => [s.revisionId, s]),
    );
    for (const r of results) {
      const stamp = byRevision.get(r.revisionId);
      r.validFrom = iso(stamp?.validFrom ?? null);
      r.validTo = iso(stamp?.validTo ?? null);
    }
  }

  /** The PG rows the join reads, restricted to pages `scope` may open. */
  private loadDocs(docIds: string[], scope: AccessScope) {
    return this.prisma.document.findMany({
      where: { id: { in: docIds }, AND: [visibilityWhere(scope)] },
      select: {
        id: true,
        title: true,
        category: true,
        projectId: true,
        defaultBranch: true,
        verifiedAt: true,
        verifiedRevisionId: true,
        verificationExpiresAt: true,
        verificationFlag: true,
        ownerId: true,
        lastActivityAt: true,
        archivedAt: true,
        branches: { select: { name: true, headRevisionId: true } },
      },
    });
  }

  /**
   * Merge vector and BM25 rankings. Single-source results keep their native
   * score (BM25 normalized to 0..1 by the max); two-source results use
   * reciprocal rank fusion — raw cosine and BM25 scores are not comparable.
   */
  private fuse(vectorHits: ChunkHit[], textHits: ChunkHit[] | { chunkId: string; documentId: string; revisionId: string; text: string; headingPath: string[]; score: number }[], k: number): ChunkHit[] {
    if (textHits.length === 0) return vectorHits.slice(0, k);
    if (vectorHits.length === 0) {
      const max = Math.max(...textHits.map((h) => h.score), 1e-9);
      return textHits.slice(0, k).map((h) => ({ ...h, score: h.score / max }));
    }
    const fused = new Map<string, ChunkHit>();
    const add = (list: { chunkId: string; documentId: string; revisionId: string; text: string; headingPath: string[] }[], rank: number, hit: (typeof list)[number]) => {
      const existing = fused.get(hit.chunkId);
      const increment = 1 / (RRF_K + rank + 1);
      if (existing) existing.score += increment;
      else fused.set(hit.chunkId, { ...hit, score: increment });
    };
    vectorHits.forEach((h, i) => add(vectorHits, i, h));
    textHits.forEach((h, i) => add(textHits, i, h));
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  /**
   * BFS from the hit documents over the doc→entity relation graph. Attaches
   * each hit document's entities to its results and returns documents that are
   * only reachable through the graph, with the connecting edges as evidence.
   */
  private async expandGraph(
    scope: AccessScope,
    acl: DocumentAclFilter,
    results: SearchResult[],
    depth: number,
    relationTypes?: string[],
    includeArchived = false,
    at?: TemporalPoint,
  ): Promise<RelatedDocumentResult[]> {
    // The graph comes back without the caller's hidden pages and without the
    // entities only those pages mention (#76), so the walk cannot pass
    // through one and an attached entity list cannot name what it introduced.
    const g = await this.graph.getWorkspaceRelationGraph(scope.workspaceId, acl, at);
    const allowed = relationTypes?.length ? new Set(relationTypes) : null;
    const edges = allowed ? g.edges.filter((e) => allowed.has(e.type)) : g.edges;

    const entitiesByDoc = new Map<string, typeof edges>();
    const docsByEntity = new Map<string, typeof edges>();
    for (const e of edges) {
      entitiesByDoc.set(e.documentId, [...(entitiesByDoc.get(e.documentId) ?? []), e]);
      docsByEntity.set(e.targetKey, [...(docsByEntity.get(e.targetKey) ?? []), e]);
    }

    const hitDocIds = new Set(results.map((r) => r.documentId));
    for (const r of results) {
      const rels = entitiesByDoc.get(r.documentId);
      if (rels?.length) {
        r.entities = [...new Set(rels.map((e) => e.targetKey))].map((key) => ({
          key,
          type: g.entities[key]?.type ?? 'entity',
          name: g.entities[key]?.name ?? key,
        }));
      }
    }

    // depth = entity hops: docs sharing an entity with a hit are distance 1.
    const related = new Map<string, RelatedDocumentResult>();
    let frontierDocs = new Set(hitDocIds);
    const seenDocs = new Set(hitDocIds);
    for (let hop = 1; hop <= depth; hop++) {
      const nextDocs = new Set<string>();
      for (const docId of frontierDocs) {
        for (const out of entitiesByDoc.get(docId) ?? []) {
          for (const inc of docsByEntity.get(out.targetKey) ?? []) {
            if (seenDocs.has(inc.documentId)) {
              const existing = related.get(inc.documentId);
              if (existing && existing.distance === hop) {
                if (!existing.via.some((v) => v.entityKey === inc.targetKey && v.relationType === inc.type)) {
                  existing.via.push({ entityKey: inc.targetKey, relationType: inc.type, confidence: inc.confidence });
                }
              }
              continue;
            }
            seenDocs.add(inc.documentId);
            nextDocs.add(inc.documentId);
            related.set(inc.documentId, {
              documentId: inc.documentId,
              title: g.documents[inc.documentId]?.title ?? '(unknown)',
              distance: hop,
              via: [{ entityKey: inc.targetKey, relationType: inc.type, confidence: inc.confidence }],
            });
          }
        }
      }
      frontierDocs = nextDocs;
    }
    // The graph does not know about archive (docs/features/39): a put-away page
    // keeps its edges, so the walk reaches it and PG says whether to show it.
    // PG also has the last word on visibility (#76) and on existence, as for
    // the hits: a page it does not return is dropped, whoever is asking.
    if (related.size > 0) {
      const rows = await this.prisma.document.findMany({
        where: { id: { in: [...related.keys()] }, AND: [visibilityWhere(scope)] },
        select: { id: true, archivedAt: true },
      });
      const shown = new Map(rows.map((r) => [r.id, r]));
      for (const id of related.keys()) {
        const row = shown.get(id);
        if (!row || (!includeArchived && row.archivedAt)) related.delete(id);
      }
    }
    return [...related.values()].sort((a, b) => a.distance - b.distance || b.via.length - a.via.length);
  }
}
