# 57 — The temporal graph: as-of reads, release tags, contradictions and communities

Issue [#81](https://github.com/hrustalq/knowledge/issues/81), shipped as nine
PRs (#321–#328 and the one carrying this document). Before it, the graph could
say what was related but not **when**. A fact a page dropped vanished from
every view without a trace. Nothing could answer "what did we say about
`service:billing` at release v2.3?". Nothing checked whether two pages, or a
page and the code, disagreed. And nothing answered a question about the whole
knowledge base rather than about a page.

Now every fact and every passage carries the interval it was true. The graph,
search, entity routes and page content can all be read as of a date, a
revision or a named release. Contradictions between pages, and between a page
and a pull request, are found, kept and closed. Communities of related pages
are summarised for broad questions.

## What

- **Valid time and system time.** Every revision's chunks and revision-scoped
  edges carry `validFrom` and `validTo`: from the revision's finalize time
  until the next default-branch revision's. Edges also carry `ingestedAt`,
  `expiredAt` and `retractedBy`. Removing a fact closes or expires its row; it
  is never deleted.
- **As of.** `asOf` accepts an ISO date, `rev:<revisionId>` or `tag:<name>`,
  and `knownAt` accepts an ISO date. Both work on:
  - the workspace and document graphs;
  - page content (the revision current then);
  - the entity list, neighbours and trace, and impact analysis;
  - search, across all three legs;
  - the matching MCP tools.

  Each response echoes `resolvedAsOf`.
- **Release tags.** Named instants (`v2.3`, `Q3 audit`) per workspace,
  optionally per project, that `asOf=tag:` resolves to. They are kept in
  **Settings → Releases** and `knowledge_create_release_tag`.
- **Time in the app:**
  - a timeline strip on the graph, with tag ticks and change density;
  - a **Show changes since** overlay;
  - an **As of** filter in search, with **Superseded** badges on results;
  - a read-only page view for `?asOf=`.
- **Contradictions.**
  - The **arbiter** agent finds passages in two pages that disagree.
  - The **sentinel** (feature [35](35-pr-drift-check.md)) records a page a pull
    request makes untrue as a page-vs-code conflict.
  - Both are kept as `knowledge_conflicts` rows. People resolve, dismiss or
    propose a fix from the page rail or **Contradictions**, and a merged fix
    closes its conflict.
- **Communities.** The **atlas** agent groups related pages and summarises
  each group. Ask's `global_overview` tool, `knowledge_global_overview` and
  `GET /v1/graph/communities` answer broad questions from those summaries. The
  graph can colour pages by community. This is off by default.

## The rules

**Valid time comes from PG, never from content.** `revisionStamps`
(`graph/temporal.ts`) is a pure function of a page's finalized revisions:

- The default branch's history is its finalized revisions in `finalized_at`
  order, and each one is valid until the next.
- A legacy revision with no branch id belongs to the default branch.
- A branch revision has `lineage = 'branch'` and is never valid.
- A draft is not stamped.

After each job the processor rewrites the stamps of the revision it indexed
and its two neighbours (`stampWindow`), reading PG afresh, so jobs that finish
in any order converge on the same intervals. `loadRevisionStamps` is the one
read the processor, the BM25 repair sweep and the backfill all stamp from.

**`live` is still the current view.** The #83 flag stays the hot path. A read
with no `asOf` uses `live`, and a read with one uses the as-of predicate. There
is no second "current" column.

**One as-of predicate.** `asOfEdgeClause` is the only edge predicate:

```
(validTo IS NULL OR validTo > :asOfAt)
AND ((lineage = 'default' AND validFrom <= :asOfAt)
     OR (lineage IS NULL AND validFrom IS NULL AND NOT <revision-scoped extractor>))
AND (ingestedAt IS NULL OR ingestedAt <= :asOfKnown)
AND (expiredAt IS NULL OR expiredAt > :asOfKnown)
```

- `asOfChunkClause` is the same interval for chunks, without system time.
- OpenSearch spells the chunk predicate as `term`/`range` filters.
- Both instants are bound parameters. A document-level edge written before
  #81 reads as valid all along. An unstamped revision-scoped row reads as
  absent until the backfill reaches it.
- An as-of graph keeps only the entities some valid edge mentions: an entity
  exists at a point only through a fact.

**Nothing a page or a person stops asserting is deleted.**

- A re-index of the *same* revision diffs its facts by `(type, targetKey)`.
  Re-asserted facts are updated in place and new ones are created. Dropped
  ones are **expired** (`expiredAt`, `retractedBy: 'extractor'`, `live =
  false`): the page did not change, the belief did.
- `DELETE …/relations`, the explicit re-post and curation **retract** the old
  edge (`retractedBy: user:<id>`). A document-level edge also closes
  `validTo`.
- The facts timeline lists retracted facts as `status: 'retracted'`.
- `deleteDocumentGraph` still erases: deleting a page is erasure, not history.

**`asOf` resolution.** `TemporalResolverService`:

- An ISO date is used as-is, and a future one clamps to now.
- `rev:` resolves to that revision's finalize time, looked up under the
  caller's workspace. Another workspace's revision is a 404, like a missing
  one, and a draft is a 400.
- `tag:` resolves to the tag's instant.
- `knownAt` alone keeps valid time at now.
- Every as-of read takes the same `AccessScope`/`DocumentAclFilter` as its
  current read (feature [48](48-page-permissions.md)).

**A conflict is one row per disagreement.**
`knowledge_conflicts.fingerprint` is unique per workspace:

- For the arbiter, it is both pages plus both whitespace-folded quotes,
  order-free.
- For the sentinel, it is the page plus `pr:<connector>#<number>`, because
  the model rewrites its claim on every push.

`ConflictsService.record` is one guarded `INSERT … ON CONFLICT … DO UPDATE …
WHERE status = 'superseded' [OR (refreshOpen AND status = 'open')]`:

- A new conflict is created.
- A superseded one reopens against the new revisions.
- The sentinel's open row takes the newest judgement and keeps a fix already
  proposed for it.
- Anything else is left alone, so **a dismissed conflict stays dismissed**.

**A judgement stands only on its evidence.**

- The arbiter's pairs are deterministic (`candidatePairs`):
  - passages from different pages, by chunk cosine
    (`CONTRADICTION_MIN_SIMILARITY`, with 0.1 of slack when the graph says the
    pages share an entity);
  - at least one side in scope;
  - the closest pair per page pair, up to `CONTRADICTION_MAX_PAIRS_PER_RUN`.
- The model's answer is kept only if both quoted sentences are in their
  passages (`readJudgement`) and its confidence clears
  `CONTRADICTION_MIN_CONFIDENCE`.
- The sentinel's quote is kept only if it is on the page; otherwise the
  verdict's title stands in.

**A conflict follows its pages.**

- When a page's new head goes live, its open conflicts quoting an older
  revision become `superseded` (in the processor, non-fatal).
- `AgentFindingsService.propose` links a finding's conflict to the merge
  request it opens, whether the proposal came from the conflict, the runs
  panel or the drift sweeper.
- `MergeRequestsService.merge` resolves the open conflicts linked to the merge
  request it merged.

**A community is withheld whole.** Its summary was written from every page in
it, so `CommunitiesService` returns a community only when the reader may open
all of its pages. The same rule covers Ask, MCP, REST and the colouring.

## Decisions

**Per-revision rows, not collapsed intervals.** The issue proposed one edge
per continuous fact, diffed on every new head: four reconcile cases, a Redis
per-document lock and a late-arrival rule. #83 already kept every revision's
rows, so stamping them is a few `UPDATE`s per job, order-free, and the backfill
is the same function. The cost is rows: a fact a page keeps asserting has one
row per revision, as before. `factChangeDays` cancels the close/open pair at
each revision boundary, so the timeline counts real changes. Collapse closed
intervals if graph growth is ever measured as a problem.

**Timestamps are epoch-ms `LONG`.** They bind and compare trivially over the
HTTP API. `DATETIME` binding there was unverified.

**No edge-property indexes, and no `Entity.ingestedAt`.** The `live` filter
already scans under the per-type `LIMIT 20000`. Nothing would read an entity's
own timestamp, because an entity's validity is derived from its edges.

**On-index contradiction checks are a trigger, not a flag.** The arbiter is a
page-scoped agent, so #70's `page.indexed` trigger hands it the indexed page.
The issue's `CONTRADICTION_CHECK_ON_INDEX` env and `ai_settings.contradictionCheck`
would have duplicated that. With no trigger configured, indexing never starts a
run.

**Resolving a conflict is a status.** "B supersedes A" writes no
`SUPERSEDES` edge: edges are page → entity, and a page-as-target convention
does not exist. Nothing writes `SUPERSEDES` or `CONTRADICTS`.

**Not built: functional-relation owner clashes.** The issue's candidate rule
(c) would pair two pages owned by different teams. That is a contradiction only
when both describe the same thing, which is what passage pairing already finds.

**Communities: no `graphology`, no global search mode.**

- One Louvain level (`agents/communities.ts`) is about 60 lines with a test,
  less surface than two packages.
- The agent's schedule decides how often it runs, so there is no
  `COMMUNITY_MIN_REBUILD_HOURS`. An unchanged projection fingerprint skips the
  rebuild.
- Answering a broad question is Ask's job, with `global_overview` as a tool,
  so `finalizeCitations` settles the citations. `mode: 'global'` on
  `/v1/search` would have put a model call inside search.
- Communities are ArcadeDB `Community` vertices with a member list rather than
  `IN_COMMUNITY` edges. They are structural and never join
  `RELATION_EDGE_TYPES`.

## Surface

| Route / tool | Role | Notes |
| --- | --- | --- |
| `?asOf=&knownAt=` on `GET /v1/documents/graph`, `GET /v1/documents/:id/graph`, `GET /v1/documents/:id/content`, `GET /v1/entities`, `…/:key/neighbors`, `…/trace`; body on `POST …/:key/impact-analysis` and `POST /v1/search` | unchanged | echo `resolvedAsOf`; 400 malformed, 404 unknown tag or foreign revision |
| `GET /v1/release-tags`, `POST /v1/release-tags`, `DELETE /v1/release-tags/:id` | viewer, editor, admin | 409 `release-tag-duplicate`; `release-tag` workspace source |
| `GET /v1/graph/timeline` | viewer | tags + per-day facts opened/closed in a window, computed per request |
| `GET /v1/conflicts`, `GET /v1/conflicts/:id` | viewer | both pages must be visible; `conflict` workspace source |
| `POST /v1/conflicts/:id/resolve`, `…/dismiss`, `…/propose` | editor | 409 `conflict-not-open`, `already-proposed` |
| `GET /v1/graph/communities?q=&limit=` | viewer | closest to `q` first |
| MCP `asOf`/`knownAt` on `knowledge_search`, `knowledge_get_workspace_graph`, `knowledge_find_relations`, `knowledge_impact_analysis`, `knowledge_trace_relation`; `asOf` instead of `atRevisionId` on `knowledge_get_historical_context` | unchanged | |
| MCP `knowledge_list_release_tags`, `knowledge_list_conflicts`, `knowledge_global_overview` | viewer | |
| MCP `knowledge_create_release_tag`, `knowledge_resolve_conflict` | editor | in `WRITE_TOOLS` |
| Ask read tool `global_overview` | viewer | summaries untrusted, member pages citable |
| Agents `arbiter` (page-scoped) and `atlas` | Run, schedule, trigger | `AiUsageOperation` `contradiction` / `community` |
| Web | | graph timeline strip + Time section, search **As of**, `?asOf=` page view, **Settings → Releases**, page-rail **Contradictions**, `/conflicts`, **Colour pages by community** |

## Operations

- Migrations `20261114100000_release_tags` and
  `20261115100000_knowledge_conflicts`. Both are new tables that the previous
  image never reads, so a code rollback is safe.
- Run `make graph-live-backfill` once after deploying. It stamps valid time on
  rows written before #81, in the graph and the BM25 mirror alike, and it is
  idempotent and safe beside a running worker. Without it, as-of reads find no
  history for older pages; current views do not depend on it. The target
  builds first, so on a dev machine it restarts `make dev`.
- New env vars, all with defaults:
  - `CONTRADICTION_MIN_SIMILARITY` (0.82), `CONTRADICTION_MIN_CONFIDENCE`
    (0.7) and `CONTRADICTION_MAX_PAIRS_PER_RUN` (20);
  - `COMMUNITY_SUMMARIES_ENABLED` (`false`) and `COMMUNITY_MAX_PER_RUN` (30).
- Neither agent runs until a person runs it, schedules it or adds a trigger.
  Each arbiter pair and each community summary is one model call, billed to
  the run's owner. Neither agent runs on `EMBEDDINGS_PROVIDER=stub`.
- The OpenSearch index gains `validFrom`, `validTo` and `lineage` through the
  existing mapping update on its first write, with no reindex. The BM25 repair
  sweep re-stamps every revision it re-mirrors.

## Deliberate deferrals

- **Time from content** ("from Q3 onwards"). Valid time is revision time, a
  proxy: a page edited in May about a March change records May.
- **Compacting closed intervals** (`GRAPH_HISTORY_RETENTION_DAYS`), until
  growth is measured.
- **Git tags as release tags** from a connector.
- **Code valid time** from a pull request's merge, and handling a pull
  request that closes without merging.
- **The graph timeline in the compact rail widget**, and a kind filter on
  `/conflicts`.
- **Contradictions against web sources**, and auto-applying any fix. A
  conflict only proposes, and a person merges.
- **Multi-level communities** and `IN_COMMUNITY` edges.

## Verification

- Specs:
  - `temporal-graph.spec.ts`: stamp chaining, convergence across job orders,
    the re-index diff, retraction attribution, no `DELETE`.
  - `temporal-resolver.spec.ts`: every `asOf` form, cross-workspace 404, the
    predicate's semantics evaluated as ArcadeDB would, timeline cancellation,
    the tag 409.
  - `temporal-search.spec.ts`: Postgres 14 → 16 as of v1 and now, every leg
    given the point, the OpenSearch query.
  - `contradiction.spec.ts`: pairing, quote grounding, the fingerprint,
    visibility, dismissed-stays-dismissed, the doc-code refresh, resolve on
    merge.
  - `component-drift.spec.ts`: a drifted page records a doc-code conflict.
  - `communities.spec.ts`: the projection, Louvain, the fingerprint, whole
    withholding.
  - Web: `graph-time.spec.ts`, covering `diffSince` and the time axis.
- Live on the dev stack, each recorded in its PR:
  - a dependency changed and retracted, read back through the graph, the
    timeline and `knownAt`;
  - the backfill run twice to identical stamps;
  - keyword, semantic and hybrid search as of a tag, with OpenSearch on;
  - the arbiter on two pages disagreeing about a retry count: one conflict,
    no duplicate on a re-run, Propose then 409, dismiss holding, superseded on
    edit, and a merged fix resolving it;
  - the atlas building two communities and skipping an unchanged graph;
  - the web surfaces at desktop and 390 px.
- Not run live: a sentinel check, which needs a real pull request on a
  connected repository. The Russian layouts were seen, but not walked at
  every width.
