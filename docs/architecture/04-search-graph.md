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

## Vector search

Phase 1 similarity is **cosine computed in Node**, inside
`GraphService.searchChunks`. That is deliberately unclever: it keeps the vector
store swappable, and moving to native HNSW should touch only that one method.

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
  list cap; nothing else reads the stamps yet. They are groundwork for an HNSW
  pre-filter.
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
use `knowledge_search`.

## Limits

- Cosine in Node is O(chunks) per query; it is correct, not fast, and is the
  first thing to replace under load.
- The 5× over-fetch is a heuristic. A filter matching very few documents in a
  large workspace can still return a short page. The same holds for a reader
  who can open only a small slice of a large workspace: the one refill round is
  capped at `SEARCH_ACL_MAX_FETCH`.
- Past `ACL_DENY_LIST_MAX` ids, a deny or allow list is applied to what the
  vector leg scanned (at most `CHUNK_SCAN_LIMIT` chunks), not inside the query,
  so recall can fall for a reader who sees a small slice of a large workspace.
  The real fix is an HNSW index pre-filtered on the `aclNodes` stamps, which
  exist for that reason.
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
