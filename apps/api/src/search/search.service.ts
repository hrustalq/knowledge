import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  DocumentTrust,
  RelatedDocumentResult,
  SearchDegradedLeg,
  SearchResponse,
  SearchResult,
} from '@knowledge/contracts';
import { isInactive, pageLayerOf, trustWeight, verificationStateFor } from '@knowledge/contracts';
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
import { AnalyticsRecorder, type AnalyticsCaller } from '../analytics/analytics.recorder.js';
import { CommunitiesService } from '../communities/communities.service.js';
import { layerParents } from '../graph/layers.js';
import type { SearchDto } from './search.dto.js';
import { communityPrior, firstPerPage, floorTextHits, floorVectorHits, fuseHits, type PriorCommunity, type SearchPool } from './ranking.js';
import { flatFollow, layeredFollow, walkRelated } from './expansion.js';
import { snippetPartsOf } from './snippet.js';

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
    private readonly analytics: AnalyticsRecorder,
    private readonly communities: CommunitiesService,
  ) {}

  /**
   * `scope` is required (#76): every hit, related page and entity returned is
   * one the caller may open. The stores apply the scope's page list as a
   * predicate where they can; the PG join below applies the predicate itself
   * and is the one that decides.
   *
   * `caller` files the search in the analytics log (#79) and puts its id on
   * the response. Absent for a search nobody asked — the backtest replaying.
   *
   * `observe` hands `make tune` the candidate pool (#305): both legs and the
   * state of every page they named, so it can re-rank the same retrieval under
   * other knobs without searching again. Absent everywhere else.
   */
  async search(
    dto: SearchDto,
    scope: AccessScope,
    caller?: AnalyticsCaller,
    observe?: (pool: SearchPool) => void,
  ): Promise<SearchResponse> {
    const mode = dto.mode ?? 'hybrid';
    const k = dto.limit ?? 20;
    // #443: `k` counts pages, so the chunk pool is deeper and the refill below
    // tops it up when its pages still fall short.
    const byPage = dto.groupBy === 'page';
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
    // #475: the community prior describes the current graph only, so an asOf
    // search never gets it; with weight 0 (the default) nothing below changes.
    const priorOn = settings.communityPriorWeight > 0 && !at;
    const filtered = categories || projectIds || tagKeys || states;
    // When the stores could not take the caller's page list as a predicate
    // (past ACL_DENY_LIST_MAX), the post-filter below is what drops their
    // hidden pages — over-fetch for that as for any other filter.
    const aclPostOnly = acl.kind !== 'all' && !acl.pushdown;
    const aclOverfetch = aclPostOnly ? this.config.get('SEARCH_ACL_OVERFETCH', { infer: true }) : 1;
    let fetchK = Math.max(filtered ? k * 5 : k, trustOn || priorOn ? k * 2 : k, k * aclOverfetch, byPage ? k * 3 : k);

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
    // #475: the communities the reader may see whole, read beside the PG join
    // below — for the prior and every result's `communityPath`. Scored only
    // when something reads the score, with the embedding the vector leg made.
    const communitiesRead: Promise<Array<PriorCommunity & { title: string }>> = at
      ? Promise.resolve([])
      : (async () => this.communities.scored(scope, (priorOn || observe) && embedding ? await embedding : undefined))();
    // Join PG for authoritative titles (three-store separation: PG owns
    // metadata), for everything the trust re-rank reads — the stamp, the flag,
    // the owner, the freshness clock and the archive mark — and for the
    // page-permission predicate itself (#76). The stores' filter came from a
    // list read a moment earlier; this is the read that decides.
    // A hit is kept only if this read returns its page, for every reader: a
    // page gone from PG can leave chunks behind in a store, and those must not
    // outrank real answers as "(unknown)" for whoever happens to hide nothing.
    //
    // Over every page either leg named, before the floors (#526): a floor is a
    // share of its leg's best, and that best must be a hit this search can
    // return. A hidden page, an archived one or one outside the filters set
    // the bar and then dropped out, taking the answers under it along.
    let docById = new Map<string, Awaited<ReturnType<SearchService['loadDocs']>>[number]>();
    let trustOf = new Map<string, DocumentTrust>();
    let aclFiltered = 0;
    const join = async () => {
      const pool = [...vectorHits, ...textHits];
      if (pool.length === 0) return;
      const docs = await this.loadDocs([...new Set(pool.map((h) => h.documentId))], scope);
      docById = new Map(docs.map((d) => [d.id, d]));
      trustOf = await this.trustOf(docs, settings.inactiveAfterDays);
      aclFiltered = new Set(pool.filter((h) => !docById.has(h.documentId)).map((h) => h.chunkId)).size;
    };
    // Archived pages drop first, whatever the switch says: they are put away,
    // not demoted.
    const admits = (h: { documentId: string }) => {
      const doc = docById.get(h.documentId);
      return (
        !!doc &&
        (includeArchived || !doc.archivedAt) &&
        (!taggedDocs || taggedDocs.has(h.documentId)) &&
        (!categories || categories.has((doc.category ?? 'other') as never)) &&
        (!projectIds || projectIds.has(doc.projectId ?? '')) &&
        (!states || states.has(trustOf.get(h.documentId)?.status ?? 'unverified'))
      );
    };
    // The relevance floors (#401, #416) drop weak evidence from each leg before fusion.
    let vectorFloored = 0;
    const fuse = () => {
      const vector = vectorHits.filter(admits);
      const floored = floorVectorHits(vector, settings);
      vectorFloored = vector.length - floored.length;
      return fuseHits(floored, floorTextHits(textHits.filter(admits)), fetchK, settings.rrfK);
    };
    await join();
    let hits = fuse();

    /**
     * The measurement a recall@k / MRR sweep replays.
     *
     * Recorded at every exit including the empty one — "this query returned
     * nothing" is a data point the September backtest was built to count, and a
     * harness that only sees successful searches overstates recall.
     */
    const record = (out: SearchResult[]): { searchId?: string } => {
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
        vectorFloored,
        trustApplied: trustOn,
        ...(acl.kind !== 'all' ? { aclFiltered } : {}),
        ...(degraded.length ? { degraded } : {}),
        ...(at ? { asOf: dto.asOf ?? 'now' } : {}),
        results: out.map((r) => ({ documentId: r.documentId, chunkId: r.chunkId, score: r.score })),
      });
      const searchId =
        caller &&
        this.analytics.search(caller, {
          workspaceId: dto.workspaceId,
          query: dto.query,
          mode,
          projectIds: dto.filters?.projectIds ?? [],
          resultDocIds: [...new Set(out.map((r) => r.documentId))],
          durationMs: since(startedAt),
        });
      return searchId ? { searchId } : {};
    };

    // Absent unless a leg was skipped, so a healthy response is unchanged.
    const health = () => ({ ...(degraded.length ? { degraded } : {}), ...(at ? { resolvedAsOf: at.resolved } : {}) });

    // One refill round (#76): the post-filter dropped hits, left fewer than k,
    // and a leg came back full — so it had more to give. Bounded by
    // SEARCH_ACL_MAX_FETCH, and only ever once. A vector leg the floor cut is
    // not full: whatever lies deeper scores lower still (#401). By page
    // (#443), a pool whose chunks name fewer than k pages refills the same way.
    const maxFetch = this.config.get('SEARCH_ACL_MAX_FETCH', { infer: true });
    const saturated = (vectorHits.length >= fetchK && vectorFloored === 0) || textHits.length >= fetchK;
    const short = byPage ? new Set(hits.map((h) => h.documentId)).size < k : aclFiltered > 0 && hits.length < k;
    if (short && saturated && fetchK < maxFetch) {
      fetchK = Math.min(fetchK * 2, maxFetch);
      [[vectorHits], [textHits]] = await legs(fetchK);
      await join();
      hits = fuse();
    }

    if (hits.length === 0) {
      communitiesRead.catch(() => undefined);
      return { results: [], ...health(), ...record([]) };
    }

    const readable = await communitiesRead;
    const prior = priorOn ? communityPrior(readable, settings) : new Map<string, number>();

    // The multiplicative weight, a re-sort, and only then the cut to k — the
    // weight is the point of the over-fetch above.
    const weighted = hits.map((h) => {
      const trust = trustOf.get(h.documentId);
      const weight = trustOn && trust ? trustWeight(trust.status, trust.inactive, settings.trustWeights) : 1;
      return { hit: h, documentId: h.documentId, score: h.score * weight * (prior.get(h.documentId) ?? 1), trust };
    });
    if (trustOn || prior.size > 0) weighted.sort((a, b) => b.score - a.score);

    // By page, each page's best chunk after the re-sort, then the cut.
    const ranked = byPage ? firstPerPage(weighted) : weighted;
    const results: SearchResult[] = ranked.slice(0, k).map(({ hit: h, score, trust }) => ({
      documentId: h.documentId,
      revisionId: h.revisionId,
      chunkId: h.chunkId,
      title: docById.get(h.documentId)?.title ?? '(unknown)',
      snippet: h.text.slice(0, 300),
      ...(byPage ? { snippetParts: snippetPartsOf(h.text, dto.query) } : {}),
      score: Number(score.toFixed(4)),
      ...(h.vectorScore !== undefined ? { vectorScore: Number(h.vectorScore.toFixed(4)) } : {}),
      headingPath: h.headingPath ?? [],
      ...(trust ? { trust } : {}),
    }));
    await Promise.all([at ? this.attachValidity(results) : undefined, this.attachPlacement(dto.workspaceId, results, readable, acl, at)]);

    const recorded = record(results);
    if (observe) {
      // Every page either leg named, not only the fused head: another rrfK
      // fuses a different head.
      observe({
        vectorHits,
        textHits,
        fetchK,
        k,
        trustOn,
        pages: new Map([...docById.values()].map((d) => [d.id, { ...trustOf.get(d.id)!, archived: d.archivedAt !== null }])),
        communities: readable,
      });
    }

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
        settings.layeredExpansion,
        at,
      );
      return { results, related, ...health(), ...recorded };
    }
    return { results, ...health(), ...recorded };
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

  /** What each page says about how much to trust it, by the same predicate every surface reads. */
  private async trustOf(
    docs: Awaited<ReturnType<SearchService['loadDocs']>>,
    inactiveAfterDays: number,
  ): Promise<Map<string, DocumentTrust>> {
    const issues = await this.provenance.openIssueCounts(docs.map((d) => d.id));
    const now = new Date();
    return new Map(
      docs.map((d) => {
        const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
        const trust: DocumentTrust = {
          status: verificationStateFor(d, headId, issues.get(d.id) ?? 0, now),
          verifiedAt: d.verifiedAt?.toISOString() ?? null,
          expiresAt: d.verificationExpiresAt?.toISOString() ?? null,
          ownerId: d.ownerId,
          inactive: isInactive(d.lastActivityAt, inactiveAfterDays, now),
        };
        return [d.id, trust];
      }),
    );
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
   * Where each result sits (#475): its page's layer, from the entities it
   * names in the same view the search read (live, or as of `at`), and the
   * titles of the readable communities containing it, coarsest first.
   */
  private async attachPlacement(
    workspaceId: string,
    results: SearchResult[],
    readable: ReadonlyArray<PriorCommunity & { title: string }>,
    acl: DocumentAclFilter,
    at?: TemporalPoint,
  ): Promise<void> {
    if (results.length === 0) return;
    const keys = await this.graph.entityKeysOf(workspaceId, [...new Set(results.map((r) => r.documentId))], acl, at);
    const coarseFirst = [...readable].sort((a, b) => b.level - a.level);
    for (const r of results) {
      const layer = pageLayerOf(keys.get(r.documentId) ?? []);
      if (layer) r.layer = layer;
      const path = coarseFirst.filter((c) => c.members.includes(r.documentId)).map((c) => c.title);
      if (path.length) r.communityPath = path;
    }
  }

  /**
   * BFS from the hit documents over the doc→entity relation graph. Attaches
   * each hit document's entities to its results and returns documents that are
   * only reachable through the graph, with the connecting edges as evidence.
   * `layered` (#475) walks by entity layer instead of every shared key.
   */
  private async expandGraph(
    scope: AccessScope,
    acl: DocumentAclFilter,
    results: SearchResult[],
    depth: number,
    relationTypes?: string[],
    includeArchived = false,
    layered = false,
    at?: TemporalPoint,
  ): Promise<RelatedDocumentResult[]> {
    // The graph comes back without the caller's hidden pages and without the
    // entities only those pages mention (#76), so the walk cannot pass
    // through one and an attached entity list cannot name what it introduced.
    const g = await this.graph.getWorkspaceRelationGraph(scope.workspaceId, acl, at);
    const allowed = relationTypes?.length ? new Set(relationTypes) : null;
    const edges = allowed ? g.edges.filter((e) => allowed.has(e.type)) : g.edges;

    const entitiesByDoc = new Map<string, typeof edges>();
    for (const e of edges) entitiesByDoc.set(e.documentId, [...(entitiesByDoc.get(e.documentId) ?? []), e]);
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

    // Membership comes from the pages that declare a component (#475); the
    // graph holds only pages the caller may open, so their declarations are
    // all this reads.
    const follow = layered
      ? layeredFollow(
          edges,
          layerParents(
            edges,
            new Map(
              (
                await this.prisma.componentDeclaration.findMany({
                  where: { workspaceId: scope.workspaceId, documentId: { in: Object.keys(g.documents) } },
                  select: { documentId: true, componentKey: true },
                })
              ).map((d) => [d.documentId, d.componentKey]),
            ),
          ),
        )
      : flatFollow(edges);
    const related = new Map(walkRelated({ edges, documents: g.documents }, new Set(results.map((r) => r.documentId)), depth, follow).map((r) => [r.documentId, r]));
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
