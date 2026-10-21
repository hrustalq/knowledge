# 04 — Search & graph

Retrieval is three things fused: vector similarity over chunks, optional BM25
keyword matching, and expansion across the relation graph. The graph is also
queried directly for traversal and impact analysis.

## What this is

`POST /v1/search` is the one entry point. It ranks chunks, optionally fuses a
keyword ranking, filters against PostgreSQL, and can then walk the graph to
attach entities and reach documents that no vector would have surfaced.

**All graph queries go through `GraphService`.** It is the single injection point
for the mandatory workspace predicate ([plan.md §6](../../plan.md) security
note) — there is no second path to ArcadeDB, and adding one would remove the
only guarantee that a query cannot cross a tenant boundary. Its read methods
also take a required `DocumentAclFilter`, so the same single point is where a
page restriction reaches the graph ([§Page restrictions](#page-restrictions)).

## Only the live projection is served

Every revision gets its own chunks and its own frontmatter/inferred edges, and
they are kept: the MR diff, `revisionEmbeddingShift`, `factsAt` and the facts
timeline all read them by revision id. What a **workspace-wide** read may see is
narrower (#83) — the **live projection**, meaning the chunks and
revision-scoped edges of the indexed head of each document's default branch.

- Chunks and relation edges carry a `live` flag. The worker decides it before
  writing (`live` only for the default-branch head) and, after every job,
  `GraphService.setLiveRevision` raises the current head and lowers every other
  revision of the page. Raise-then-lower, so a concurrent read sees a duplicate
  for a moment rather than a missing page; re-read the head each time, so jobs
  finishing out of order still converge.
- A head that is not yet indexed does not take over: the previous live revision
  keeps serving until it is, so a page never drops out of search mid-edit.
- `searchChunks`, `getWorkspaceRelationGraph`, `getDocumentIdsByTags`, the
  relations panel (`liveOnly`) and the OpenSearch query all filter on it.
  Removed text, dropped tags and relations, and unmerged branch drafts are
  therefore not found, not expanded and not handed to an agent.
- Explicit and curated edges are document-level and always live.
- `live IS NULL` reads as live, so rows written before the flag existed stay
  visible until `make graph-live-backfill` stamps them.

## Reading as of a point in time

Every revision-scoped row also carries the interval it was true (#81,
[feature 57](../features/57-temporal-graph.md)). `validFrom` and `validTo`
come from PG revision finalize times (`revisionStamps`). Edges additionally
carry `ingestedAt`, `expiredAt` and `retractedBy`, because a fact dropped by
re-extraction or withdrawn by a person is expired, never deleted.

- A read with no `asOf` uses `live`, unchanged. A read with one swaps `live`
  for `asOfEdgeClause` (edges) or `asOfChunkClause` (chunks), in
  `graph/temporal.ts`. These are the only two predicates, and both instants
  are bound parameters.
- `getWorkspaceRelationGraph(ws, acl, at?)`, `searchChunks(…, at?)`,
  `getDocumentIdsByTags(…, at?)` and `FulltextProvider.search(…, at?)` take
  the point, under the same `DocumentAclFilter` as their current reads.
- An as-of graph keeps only the entities a valid edge mentions.
- `TemporalResolverService` turns `asOf` (an ISO date, `rev:`, `tag:`) and
  `knownAt` into a `TemporalPoint`. A foreign revision is a 404, the same as a
  missing one.

## Vector search

`GraphService.searchChunks` and `searchRevisionChunks` ask ArcadeDB for the
nearest chunks through an HNSW index, `LSM_VECTOR` on `Chunk.embedding` with
COSINE similarity (#304). ArcadeDB returns the `k` rows, never the corpus.

```sql
SELECT chunkId, documentId, revisionId, workspaceId, text, headingPath, distance
FROM (SELECT expand(vector.neighbors('Chunk[embedding]', :queryVector, :k,
  { efSearch: 400, filter: (SELECT @rid FROM Chunk WHERE workspaceId = :workspaceId AND <live | as-of> <acl>) })))
WHERE workspaceId = :workspaceId
```

- **Every restriction is inside the search.** `filter` restricts the HNSW walk
  to the RIDs its subquery returns, so a chunk of another workspace, a
  non-live revision or a denied page never takes one of the `k` slots. The
  subquery carries the workspace predicate, `LIVE` (or `asOfChunkClause`) and
  the ACL: the id list while it fits `ACL_DENY_LIST_MAX`, and past it a
  member's `aclNodes` stamps (the OpenSearch rule). The outer `WHERE` repeats
  the workspace, and `aclAdmits` still runs last. PG decides after that, as
  [§Page restrictions](#page-restrictions) says. `searchRevisionChunks` filters
  on its revision list instead of `live`.
- **`score` is cosine.** ArcadeDB's COSINE `distance` is `1 - cosine` for any
  vectors, normalized or not (checked against a cosine computed outside it).
  So `score = 1 - distance` is the number the scan produced, and the capture
  and duplicate thresholds calibrated on it still hold.
- **`efSearch` is 400** (`VECTOR_EF_SEARCH`, never below `k`). The index's
  adaptive default lost recall on the demo corpus. The measurement is below.
- **One index, one dimension.** The worker builds it in `ensureSchema` for
  `EMBEDDINGS_DIM`, after declaring `Chunk.embedding` as `ARRAY_OF_FLOATS`.
  Stored rows are not converted; the index reads them as they are. When
  `EMBEDDINGS_DIM` changes, the worker drops the index and builds it again for
  the new dimension. ArcadeDB skips every stored vector of another length
  while building, keeps those rows in the type unindexed (updating their other
  fields still works), and refuses to insert one afterwards. So during a
  reindex the vector leg ranks only what is already re-embedded and BM25
  finds the rest, as before, and a stale vector is never compared. One
  property per dimension (`embedding_1024`) was the other option. It was not
  chosen because it keeps two indexes for a state that lasts one reindex.
- **Until the index exists, it scans.** The API learns the index's dimension
  from `schema:types` and caches it for 30 s. If there is no index, if the
  index has another dimension (the API restarted before the worker rebuilt
  it), or if ArcadeDB rejects the query, `searchChunks` falls back to the
  pre-#304 scan: up to `CHUNK_SCAN_LIMIT` (5,000) vectors ranked in Node, with
  an error logged at the cap. `ensureSchema` never fails the worker's boot
  over the index.
- **Readers that need every vector page instead of capping.** `liveChunks`
  (the capture calibration backtest) and `meanRevisionEmbeddings` (the
  doc-quality duplicate check) read the matching RIDs first, then load them
  1,000 at a time by RID with the predicate applied again. Keyset paging
  (`@rid > :last ORDER BY @rid`) was tried and dropped: on 26.10.2 that order
  is not global once the planner splits `LIVE`'s `OR` into two branches, and
  a page boundary skipped rows.
- **ArcadeDB is pinned to 26.10.2** by tag and digest in both compose files.
  Its `filter` accepts a subquery. The `26.9.1-SNAPSHOT` the dev stack ran
  rejects one ("must contain RIDs").

### Pre-filter: one RID subquery, not a bucket per workspace

Two layouts were considered. (a) is built; (b) was not measured.

- **(a)** `filter: (SELECT @rid FROM Chunk WHERE workspaceId = …)`. No layout
  change. The subquery reads RIDs through the `workspaceId` index, without
  vectors. When the filter is narrower than ArcadeDB's
  `vectorIndex.prefilterMaxSelectivity` (20% of the index), ArcadeDB skips
  the graph walk and scores the filtered set exactly. That is why a small
  workspace sharing a server with a large one gets recall 1.0 below.
- **(b)** `partitioned(workspaceId)` buckets, one HNSW graph per workspace.
  On the demo corpus one workspace holds 5,936 of 6,266 chunks, so a
  partition would narrow nothing for it, and small workspaces already take
  the exact path. It also means rewriting every Chunk into new buckets.
  Revisit it if a second large tenant shares a server and (a)'s p95 grows.

### Measurement (2026-10-20)

**Corpus.** The local dev stack's chunks were copied read-only into a
throwaway ArcadeDB 26.10.2 container with production's heap (`-Xmx1g`), on a
laptop: 6,266 bge-m3 chunks (1024-d), 5,936 of them matching the demo
workspace's live predicate (4,191 stamped live, 1,745 never stamped). The
vectors are real, but this is not production's corpus. **Queries:** the first
120 demo page titles by id, embedded with bge-m3, which is the backtest's
known-item query. **Exact:** cosine over every eligible chunk. Latency is the
ArcadeDB round trip from Node; embedding the query is not included.

| Read                                        | rows  | response | p50    | p95      | recall vs exact          |
| ------------------------------------------- | ----- | -------- | ------ | -------- | ------------------------ |
| Before: the scan, as `searchChunks` read it | 5,000 | 71.0 MB  | 854 ms | 1,552 ms | arbitrary 5,000 of 5,936 |
| Index, adaptive efSearch, k = 10            | 10    | 18 KB    | 32 ms  | 55 ms    | @10: 0.947 (min 0.2)     |
| Index, efSearch 200, k = 10                 | 10    | 18 KB    | 26 ms  | 32 ms    | @10: 0.978 (min 0.6)     |
| **Index, efSearch 400, k = 10**             | 10    | 18 KB    | 27 ms  | 32 ms    | **@10: 0.988** (min 0.8) |
| Index, efSearch 400, k = 50 (5× over-fetch) | 50    | 103 KB   | 30 ms  | 35 ms    | @50: 0.993               |
| Index, efSearch 1600, k = 10                | 10    | 18 KB    | 29 ms  | 35 ms    | @10: 0.998               |
| Index, 85-chunk workspace, k = 10           | 10    | 4 KB     | 3 ms   | 5 ms     | @10: 1.0                 |

- No row from another workspace came back in any run.
- Building the index over 6,266 vectors took 1.8 s.
- **Concurrency, same 1 GB heap.** Two loops of the old scan: 1 of 20 reads
  died with `OutOfMemoryError: Java heap space`. Four loops: 17 of 20. The
  index read (k = 50) in four loops of 50 reads: no failures, p95 91 ms.
  Eight loops: no failures, p95 125 ms.

**Still to run:** `make backtest` (recall@1 against the 63.3% of 2026-10-15)
and `make backtest ARGS="--captures"` on the dev stack once it runs the pinned
image, and the same measurement on production's corpus after the deploy.
`apps/api/test/vector-index.e2e-spec.ts` checks the behaviour above against a
real ArcadeDB (set `ARCADE_VECTOR_TEST_URL` to a throwaway server).

## BM25, behind a provider token

Full-text mirrors the embeddings pattern exactly:

| `FULLTEXT_PROVIDER` | Behaviour                                                |
| ------------------- | -------------------------------------------------------- |
| `none` _(default)_  | Vector only. `mode: 'keyword'` silently falls back to it |
| `opensearch`        | Plain-HTTP client, no SDK; `make infra-up-opensearch`    |

The worker mirrors chunks into the index as a **non-fatal step 6b** — a failure
to index for keyword search must never fail a revision that is otherwise
retrievable. Hybrid ranking fuses the vector and BM25 orderings by **reciprocal
rank fusion**; `mode: 'keyword'` is BM25-only.

### Analyzed fields (#400)

Chunk `text` keeps the `standard` analyzer and carries two multi-fields:
`text.ru` (built-in `russian`) and `text.en` (built-in `english`), each with
its language's stemming and stopwords. «ветки» and «ветка» meet at `ветк`,
and «от», «при», `from` and `which` drop out.

`bm25Clause` queries **one** of them, picked by the query's script: any
Cyrillic letter sends it to `text.ru`, anything else to `text.en`. Latin tokens
in a Russian query (`main`, `MR`) pass the Russian analyzer unchanged. Each
analyzer drops only its own language's stopwords, so a `most_fields` sum over
all three fields counted «от» and «при» once per field that kept them, and a
3 200-character Docker chunk outranked the branching pages on stopwords. The
raw `text` field is no longer queried.

The match carries `minimum_should_match: '2<60%'`: a query of up to two
analyzed terms needs all of them, a longer one 60% of them, rounded down (3
terms → 1, 4 → 2, 10 → 6). One shared generic token (`base`) is no longer a
hit. What it cannot do is bridge word families. The Snowball stemmer leaves
«базироваться» as `базирова` and «база» as `баз`, so «От какой ветки
базироваться при разработке фичи?» shares only `ветк` with the page that
answers it, and BM25 returns nothing for it. That page reaches the answer
through the vector leg, and cross-language matching (`feature` ↔ «фича») is
the vector leg's job as well.

An index created before #400 takes the multi-fields through the boot
`_mapping` update, as it does `ACL_PROPERTIES`. `OpenSearchFulltextProvider.reanalyze`
then counts rows with no `text.ru` and, if there are any, starts a background
`_update_by_query` that rewrites them from their own `_source`. Nothing is
re-chunked or re-embedded. Until it finishes, those rows are invisible to
BM25. The check reads the rows rather than the mapping, so a backfill cut
short by a restart resumes on the next boot.

The read path is just as optional (#173). `SearchService.fulltextLeg` races the
BM25 query against `FULLTEXT_TIMEOUT_MS` (default 1500). If it errors or loses
the race, the search drops that leg and answers from vectors alone. A keyword
search runs the vector leg it would have skipped. The response carries
`degraded: ['fulltext']`, and so does the `search.executed` measurement, so a
backtest does not score a vector-only answer as a hybrid one. A healthy
response has no `degraded` key at all. The service warns once when the index
starts failing and logs again when it recovers, rather than warning on every
search during an outage.

A failed write leaves the index behind the graph. The revision is stamped
`fulltext_stale_at`, and the stale sweeper re-mirrors it from the graph's
chunks ([03](03-ingestion.md#stale-detection-and-reindex)). Restriction stamps
need nothing new: `AclRestampSweeper` advances `acl_stamped_version` only after
both stores take the stamp, so a failed OpenSearch restamp is simply retried.

## Filters are applied after ranking

`filters.categories` and `filters.projectIds` are resolved **post-ranking against
PostgreSQL**, under a 5× candidate over-fetch. The graph holds semantic facts,
not UI structure, so project and category membership are not modelled as edges —
which means filtering cannot happen during the graph query and must happen after
it, with enough candidates over-fetched that a filtered page is still full.

## Page restrictions

`SearchService.search(dto, scope)` takes a required `AccessScope` (#76), and so
does every caller: the HTTP and MCP routes pass the person's, a system job passes
`systemScope(workspaceId)`, which is greppable on purpose.

- **The stores get a list.** `PermissionService.documentFilterFor(scope)` reads
  PG once per search and returns a `DocumentAclFilter` (`common/document-acl.ts`):
  `all`, `deny` (a member's hidden pages) or `allow` (a guest's reachable pages).
  `GraphService.searchChunks`, `getDocumentIdsByTags` and
  `getWorkspaceRelationGraph` and the fulltext provider's `search` all require
  one. Up to `ACL_DENY_LIST_MAX` ids it goes into the query (`documentId IN` /
  `NOT IN` in ArcadeDB, a `terms` filter in OpenSearch); past that the store
  filters what it scanned in memory, and search over-fetches by
  `SEARCH_ACL_OVERFETCH`.
- **PG decides.** The join that loads titles and trust applies
  `visibilityWhere(scope)` itself, and a hit whose page it does not return is
  dropped, **for every reader**. That covers pages deleted from PG whose chunks
  outlived them in a store, which used to come back as "(unknown)" for a reader
  who hid nothing and outrank the real answer. Graph expansion's related pages
  pass the same check. A store that lagged or ignored the filter can lose
  recall, never show a page.
- **The limit holds.** If that post-filter dropped hits, left fewer than `limit`
  and a leg came back full, one refill round runs with the fetch doubled, capped
  at `SEARCH_ACL_MAX_FETCH`. `search.executed` records `aclFiltered`.
- **Entities follow their pages.** `getWorkspaceRelationGraph` drops a hidden
  page's edges and then every entity no remaining edge names, so a restricted
  page cannot leak a name it introduced through expansion, the graph view or
  entity lists. With `all` it returns exactly what it did before.
- **Stamps are a prefilter.** Indexing stamps `aclNodes` (the page's
  `restricted_by`) and `aclRestricted` on the Document vertex, every chunk and
  every OpenSearch row. `AclRestampSweeper` (worker, `ACL_RESTAMP_TICK_MS`)
  rewrites them for pages whose `acl_version` is ahead of
  `acl_stamped_version`, guarded on the version it stamped; nothing is
  re-embedded. OpenSearch falls back to `must_not aclNodes ∈ denied` past the
  list cap, and so does the vector index's pre-filter
  ([§Vector search](#vector-search)).
- `getDocumentRelations` takes no filter: it is per page, reached through a
  route the guard has already checked, and its edges point at entities, not
  pages.

## Trust re-rank

Since [feature 39](../features/39-page-verification.md) the PostgreSQL join also
reads the page's stamp, declared flag, owner, activity clock and archive mark.
Archived pages are dropped first — they are put away, not demoted — and the rest
have their fused score multiplied by `trustWeight(status, inactive)`
(`TRUST_WEIGHTS` in contracts: verified 1.15, expired/flagged 0.85, outdated 0.5,
inactive ×0.9), re-sorted, and only then cut to `k`. Multiplicative so the same
factor serves RRF, cosine-only and max-normalized BM25 scores.

The fusion constant and the weights are per-workspace knobs (#305): `rrfK`
and `trustWeights` on `knowledge_health_settings`, sparse over
`SEARCH_RRF_K` (60) and `TRUST_WEIGHTS`, and sparse per state, so overriding
one weight keeps the other seven. `VerificationPolicyService` resolves them on
the same read that resolves `trustRanking`, so they cost no extra query, and
an empty row ranks byte-for-byte as before. `fuseHits` and the re-rank live in
`search/ranking.ts`, where `rankPool` replays them over a recorded
`SearchPool`. That is how `make tune` scores thousands of knob settings
against one search per query
([55](../features/55-learning-loop.md#the-tuner)). The parity case in
`search-trust.spec.ts` keeps `rankPool` and `SearchService` in step.

With the re-rank on, `fetchK` is at least `2k` so a demoted hit has something to
be displaced by. With it off (`SEARCH_TRUST_RANKING=false`, or the workspace's
`trustRanking` override), `fetchK` and the order are exactly the pre-feature
ones: RRF over a longer candidate list is a different ranking, and "off"
promises the old one. The switch is resolved by `VerificationPolicyService`, the
one place the effective freshness policy is read. Every hit carries
`trust: { status, verifiedAt, expiresAt, ownerId, inactive }`, and the backtest
event records `trustApplied` so two runs can be compared. New post-ranking
filters: `verificationStates[]`, `includeArchived`.

## The graph is bipartite

**Edges always run Document → Entity**, with a `doc:<id>` node convention, and
BFS runs **in Node** over `GraphService.getWorkspaceRelationGraph` using the pure
helpers in `src/graph/graph-walk.ts`. One entity hop is therefore two BFS hops.

**This diverges from [plan.md §6](../../plan.md)**, which models
`(Entity)-[:DEPENDS_ON]->(Entity)` directly and performs multi-hop traversal in
Cypher (`*1..2`). Read plan.md §6 as design intent; the bipartite projection is
what exists. Without this note the plan reads as simply wrong against the code.

## Fact classes and inference

Five provenance classes share one edge table, ordered by how much a human
vouched for them ([plan.md §5](../../plan.md)):

| `extractor`   | Source                                               | Confidence |
| ------------- | ---------------------------------------------------- | ---------- |
| `explicit`    | `relations[]` on create, or the relations endpoint   | 1          |
| `frontmatter` | Parsed from the document — see [03](03-ingestion.md) | 1          |
| `inferred`    | The LLM extractor                                    | clamped    |
| `curated`     | A human confirming or correcting a fact              | 1          |
| `code`        | A codebase connector's import index ([51](../features/51-component-pages.md)) | 1 |

Extraction is pluggable behind the `RELATION_EXTRACTOR` token (`src/extraction/`),
mirroring embeddings: `none` (default) or `openai-compatible`
(`EXTRACTOR_BASE_URL` must include `/v1`, chat completions, JSON output).
Inferred edges carry a clamped confidence at or above `EXTRACTOR_MIN_CONFIDENCE`,
plus `sourceChunkId` and a `snippet` — a claim you cannot trace to a passage is
not a claim worth storing.

Two rules matter more than the mechanism:

- **Extraction failures are non-fatal.** The revision stays `indexed`; a missing
  inference is a smaller problem than an unsearchable document.
- **With `none`, the worker still runs the step**, in order to _clear_ stale
  inferred edges. Turning the extractor off must retract what it previously
  asserted, not freeze it in place forever.

### Protecting curated facts

`GraphService.replaceRevisionInferredFacts` deletes only _that revision's_
inferred edges, and **skips any `(type, target)` already covered by a curated or
explicit edge**. A model re-running over a page can therefore never overwrite a
human's correction — the correction simply wins, silently and permanently.

Curation surface:

```
POST   /v1/documents/:id/relations/curate   confidence 1, replaces inferred/curated dups
DELETE /v1/documents/:id/relations          ?type= &targetKey= &extractor=
```

## Traversal

```
GET  /v1/entities
GET  /v1/entities/trace                    ← declared BEFORE the :key routes
GET  /v1/entities/:key/neighbors
POST /v1/entities/:key/impact-analysis
```

`trace` must be declared before `:key` or Nest matches it as an entity named
"trace" — the declaration-order rule, with teeth.

**Impact analysis** is defined in both directions: _dependents_ are the documents
referencing the entity, then the entities those documents `DESCRIBE`;
_dependencies_ are the reverse walk.

## Hybrid expansion

`expandGraph: { depth, relationTypes }` on `POST /v1/search` attaches `entities`
to every hit and returns a `related[]` of documents reachable **only** through
the graph, each carrying the connecting edges as evidence. A result that a
reader cannot audit back to a stated relationship is not a result they should
act on.

## Provenance on results

A hit is a `(documentId, revisionId, chunkId, score)` and, since
[feature 38](../features/38-answer-provenance.md), the chunk's `headingPath` —
the vertex has always carried it; surfacing it is what lets a citation link to a
section. What a hit is _worth_ — the head revision's number and author, when it
last changed, whether a person has stamped it — is not a search concern and is
not computed here. `ProvenanceService` (`feedback/`) resolves it from PostgreSQL
in one batch at the end of an answer, and the MCP `knowledge_search` handler
runs the same decoration over its hit list. Search stays a ranking; trust is a
read on top of it.

The read goes the other way too, once. Votes on answers (`answer_feedback`) are
the only ground truth about retrieval that a person produced: an up-vote names
the pages that answered a question, a "wrong" down-vote names the pages that did
not. `FeedbackDatasetService` turns them into `FeedbackBacktestCase` lines and
`make backtest --feedback` replays them through `SearchService.search` — so a
change to fusion, chunking or embedding is measured against what people asked,
not only against each page's own title. Nothing in search reads that table;
feedback is a benchmark, never a ranking signal.

## Security

Edge type names are **SQL-interpolated**, so every type is validated against
`RELATION_EDGE_TYPES` in `GraphService`. **Never widen that list without keeping
the allowlist check** — it is the only thing standing between a relation type and
injection.

Operator access to the raw graph is a separate, audited path; see
[06 — Auth & ACLs](06-auth-acl.md). It is the one graph read that ignores page
restrictions, since it is open only to admins, who bypass them anyway; its
audit row carries `aclBypass: true`.

## MCP

`knowledge_search`, `knowledge_find_relations`, `knowledge_impact_analysis`,
`knowledge_trace_relation`, `knowledge_get_historical_context`. Each passes the
caller's `AccessScope`, exactly as the REST route it mirrors does; guests may
use `knowledge_search`. `knowledge_search_chat` is the chat path's tool (see
*Chat search* below), read-only and guarded the same way.

## Recording searches

Each search is measured twice, for two readers. `emitBacktest` writes a
`search.executed` line to the per-service JSONL stream at every exit: the
query, the timings of each leg and the ranked chunk ids. That is what `make
backtest` replays to measure recall, and it records every search, the backtest's
own replays included.

When the caller passes an analytics context (REST, MCP, the assistant's tools,
agent and workflow runs), `AnalyticsRecorder.search` also writes one
`search_queries` row in PostgreSQL ([feature 58](../features/58-usage-analytics.md)):
the channel, the result count, the top documents and a `searchId` the response
carries for click-through. That row is product data. It is workspace-scoped,
read by the `/analytics` dashboard and `knowledge_list_search_gaps`, kept only
for the workspace's retention, and its query text is redacted after
`ANALYTICS_QUERY_TEXT_DAYS`. A search with no context (the backtest replaying,
the PR-drift candidate search) writes the JSONL line and no row. The write is
fire-and-forget and never fails the search.

## Chat search

Searchable groups' chat ([feature 60](../features/60-chat-search.md)) is a
second, separate retrieval path that shares this one's parts, not its data.
`ChatSearchService` never touches `Chunk`, `documents` or the fulltext
provider, and `POST /v1/search` never returns a chat window.

- **Vectors:** a `ChatChunk` vertex type with its own `LSM_VECTOR` index,
  `ChatChunk[embedding]`. `ensureVectorIndex` and `vectorIndexFits` take the
  vertex type as an argument, so the two indexes are built, sized and rebuilt
  on an `EMBEDDINGS_DIM` change by the same code. `nearestChatChunks` is the
  page query's twin, pre-filtered by the same kind of RID subquery: the
  workspace and the readable binding ids.
- **Text:** a generated `to_tsvector('russian', text)` column on
  `chat_chunks`, GIN-indexed and queried with `plainto_tsquery`. It is
  Postgres, not the BM25 provider, so it works with `FULLTEXT_PROVIDER=none`.
- **Fusion:** the same `fuseHits` RRF (k = 60) over a 4× over-fetch.
- **ACL first.** The readable bindings are decided in Postgres before either
  leg runs (`canSeeChat`: the binding's project under the caller's
  `AccessScope`; a project-less binding is never shown to a guest). Both legs
  take only those ids, and the final read joins `chat_chunks` on them again.
  As with pages, Postgres has the final say. A vector whose row is gone is
  never served; the indexer reaps it.

## Communities

The atlas agent ([feature 57](../features/57-temporal-graph.md)) groups pages
with one Louvain level over the page-to-page projection (`agents/communities.ts`).
Two pages are linked once per entity they share; hubs named by more than 12
pages are skipped. Each group's summary is stored as an ArcadeDB `Community`
vertex with its embedding. These are structural, outside `RELATION_EDGE_TYPES`,
and never walked. `CommunitiesService` ranks them by cosine to a question and
withholds a community whose pages the reader may not all open.

## Limits

- Vector search is approximate: recall@10 0.988 against the exact ranking on
  the demo corpus at `efSearch` 400. A larger corpus may need a wider beam.
- Until the worker has built the vector index, the vector leg scans at most
  `CHUNK_SCAN_LIMIT` chunks, as it did before #304.
- The 5× over-fetch is a heuristic. A filter matching very few documents in a
  large workspace can still return a short page. The same holds for a reader
  who can open only a small slice of a large workspace: the one refill round is
  capped at `SEARCH_ACL_MAX_FETCH`.
- Past `ACL_DENY_LIST_MAX` ids, a member's deny list reaches the vector index
  as the `aclNodes` stamps, which lag a restriction change by one re-stamp
  tick. A guest's allow list past the cap is not pushed at all: the index
  returns `k` hits and `aclAdmits` drops the hidden ones. Recall can therefore
  fall for a guest who sees a small slice of a large workspace, within
  `SEARCH_ACL_MAX_FETCH`'s one refill round.
- `make backtest ARGS="--generate --as <userId>"` measures known-item recall
  through one person's scope. It asks only about the pages that person can
  open, so a restricted page is never counted as a miss. Run it beside the
  unfiltered `--generate` to see what the filter costs a reader.
- `make backtest ARGS="--captures --workspace <id>"` measures the capture
  dedupe and amend thresholds on raw cosine, the vector leg alone (#234). The
  2026-10-16 run on bge-m3 and the stub, and why the defaults stayed at
  0.92 / 0.80, are in
  [feature 50 §Calibration](../features/50-agent-memory.md#calibration).
- Entity keys are free-form strings (`service:identity`); nothing normalises two
  spellings of the same entity into one node.
