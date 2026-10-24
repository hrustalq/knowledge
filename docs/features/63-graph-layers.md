# 63 — Graph layers: a community hierarchy and entity layers that search ranks through

Issue [#475](https://github.com/hrustalq/knowledge/issues/475), shipped as six
PRs (#493–#497 and the one carrying this update). Phase 1 decided what is
below; the later phases built it, and where building it changed a decision
(the hierarchy's resolution), the section says so.

The graph is flat in two ways, and search inherits both:

- **Structure has one level.** The atlas builds one Louvain level of
  communities ([57](57-temporal-graph.md#decisions)). Nothing sits above a
  group ("billing" inside "payments"), and nothing sits between a group and a
  page.
- **Entities have no level.** `service:billing`, `component:invoice-renderer`
  and `op:post /invoices/{}` are all just keys. The graph cannot say that an
  operation belongs to a component, or a component to a service.

So `POST /v1/search` ranks chunks without either. A broad question ("how does
billing work?") gets whichever chunks repeat its words. A narrow one ("what
does POST /invoices return?") is diluted in hybrid mode: `expandGraph` treats
every shared key as one hop, and a broad `service:` key reaches every page of
the service.

## What changed

- **The atlas builds a hierarchy.** It runs Louvain again on the aggregated
  graph, up to three levels. Each `Community` carries `level` (0 = finest) and
  `parentId`. Upper levels are summarised from their children's summaries.
- **Every entity has a layer**, derived from its key's type prefix:
  `system → component → interface → code`, plus `concept` for everything else.
- **Membership between layers** ("this operation belongs to that component")
  is derived when the graph is read, and only from the pages that declare an
  entity.
- **Search can use both, off by default.**
  - A **community prior** boosts the member pages of the communities whose
    summaries match the query.
  - **Layered expansion** walks the graph from a hit at its own layer and one
    step up or down.
  - Every result says where it sits: `layer` and `communityPath`.
- `global_overview` and `knowledge_global_overview` take an optional `level`.

## Entity layers

One classifier in `@knowledge/contracts` (`entityLayerFor(key)`), read
everywhere, with an inverse (`entityTypesOfLayer(layer)`) so a graph read can
filter by layer. **Derived, never stored**, as for every classifier in this
repo. An `Entity` vertex gains no property, so nothing re-embeds or backfills.

| Layer | Rung | Type prefixes |
| --- | --- | --- |
| `system` | 0 | `system`, `service`, `domain`, `product`, `platform`, `integration` |
| `component` | 1 | `component`, `library`, `db`, `database`, `table`, `index`, `cache`, `queue`, `topic` |
| `interface` | 2 | `op`, `channel`, `spec`, `api`, `endpoint`, `event` |
| `code` | 3 | `module`, `file`, `symbol`, `function`, `class`, `task` |
| `concept` | — | everything else: `tag`, `team`, `person`, `entity`, `concept`, a bare key, any prefix not listed |

- The prefix is `entityTypeOf(key)`: the whole segment before the first colon,
  matched exactly. There is no prefix-of-a-prefix to rank.
- The list includes the spellings already in use: the codebase connector
  (`module:`), API specs (`op:`, `channel:`, `spec:`), component pages
  (`component:`) and an imported workspace's scheme (`function:`, `task:`,
  `table:`, `index:`, `cache:`, `integration:`).
- `concept` is a layer of its own, never "unknown, dropped". Its inverse is
  "none of the listed prefixes", so a read that filters on it uses `NOT IN`.
- A closed catalogue, so a value we never emit is not in it. Adding a prefix
  is a contracts change with a spec case.

**A page's layer** is the rung that holds most of its distinct entities. A tie
goes to the finer rung, so a page naming one operation and its service is an
`interface` page. A page whose entities are all `concept` is a `concept` page.
A page with no entities has no layer, and the field is absent.

## Membership between layers

Decided before phase 1: **only a page that declares an entity says what it
belongs to**, and the graph already holds every fact this needs.

- **Component pages.** A page with a `component_declarations` row declares
  that component. The `system`-rung entities that page names are the
  component's parents.
- **API spec pages.** A spec page's `DESCRIBES` edges with extractor `spec`
  declare its operations and channels. The `component`-rung entities the page
  names through its other edges are their parents. If it names none, its
  `system`-rung entities are.
  A spec has no frontmatter, so it names those in the spec itself (#519): an
  `x-knowledge-relations` list at the root (or under `info`), shaped like
  frontmatter `relations:` and read by the same `readFrontmatterRelations`.
  Ingestion hands that list to step 7 as the spec's frontmatter, so the edges
  carry extractor `frontmatter` and the spec diff never sees them.

  ```yaml
  openapi: 3.0.3
  x-knowledge-relations:
    - { type: DESCRIBES, target: service:oms }
  ```
- **Nothing else.** `code` edges record usage (a file imports a component),
  not containment. A page that merely mentions two keys links nothing.

Membership is computed when the graph is read, from the relation graph the
reader may see plus the declarations of the pages they may open. It is a pure
function (`layerParents`), never stored, and it adds no edge type, so
`RELATION_EDGE_TYPES` and its allowlist check are untouched. An entity may
have several parents. Resolution is one hop: a walk uses an entity's parents
and children, never a chain.

Under `asOf`, the edges come from the as-of read. The declarations table is
current-only, so a component's parents as of a date are the services its
current declaring page named then.

## The community hierarchy

`agents/communities.ts` keeps today's level 0 and adds the aggregation phase
it left out:

1. Level 0 is today's Louvain over the page-to-page projection. Communities of
   fewer than two pages are dropped, as now.
2. Each level's communities become the nodes of the next. Two nodes are linked
   by the sum of the page-pair weights between them, and a node's internal
   weight becomes a self-loop, so modularity is computed on the same total.
3. Louvain runs again, at **half the previous level's resolution** (level L
   uses γ = 0.5^L in generalised modularity). At resolution 1 a converged
   level 0 is already a modularity optimum, so plain aggregation merges almost
   nothing. Prototyping on four triangles of pages, paired by strong bridges,
   produced no level 1 at all. Lowering γ per level is the standard way to ask
   for the coarser grouping. The run stops when a level merges nothing or
   after **three levels** (0, 1, 2). The cap is a constant, not an env var: a
   level nobody reads costs model calls.
4. An upper community is kept only if it merges at least two communities of
   the level below. A community not merged that way has no parent, which makes
   it a root.

Each stored `Community` gains:

- `level`;
- `parentId`;
- `members`: **every page beneath it**, not only its own children. This is
  what lets the withheld-whole rule (below) be one check per row.
- `communityId`: `<level>:<smallest page id>`, so a level-0 and a level-1
  community can never share an id.

Rows built before this have no `level` and read as level 0, roots.

The run stays deterministic (ids in sorted order) and fingerprint-skipped. The
fingerprint gains a version marker, so the first run after the deploy rebuilds
once even though the projection has not changed.

**Summaries.**

- Level 0 is summarised from pages, as now.
- A level-L community is summarised from its children's titles and summaries.
  Those are model output from page text, so the prompt wraps them untrusted.
- `COMMUNITY_MAX_PER_RUN` is one budget across levels: level 0 largest first,
  then level 1, then level 2.
- An upper community with fewer than two summarised children is not written,
  and its children become roots. This keeps "every non-root community has a
  parent" true even when the budget runs out.
- A partial run (429, or a provider account error) is stored without a
  fingerprint, as now, so the next run finishes it.

## Search

### The community prior

When `communityPriorWeight > 0` and the search has no `asOf`:

1. Read the communities the reader may see whole (the rule below). Score each
   by cosine between its summary embedding and the query embedding the vector
   leg already computed. There is still **no model call inside search**. A
   keyword-only search computes no embedding, so it gets no prior.
2. **The path.** Find the coarsest level where some community scores at least
   `communityPriorFloor`, and take its best. Then take the best of that
   community's children that clears the floor, and so on down to level 0. The
   path may stop early, or be empty, in which case there is no prior.
3. **The boost.** A page's score is multiplied by `1 + weight × d / n`, where
   `n` is the path's length and `d` the number of path communities that
   contain the page. Because the path is nested, `d` is how deep the page sits
   in it: a page in the finest matched community gets `1 + weight`, a page
   only in the top one gets `1 + weight / n`, and every other page gets 1.
4. It multiplies in the same step as the trust weight and is followed by the
   same re-sort. **It boosts, never filters**, so a page outside every
   community can still rank first.
5. With the prior on, the candidate pool is at least `2k`, as with trust
   ranking. A boost needs something to displace.

`SearchPool` records each readable community's level, parent, members and
cosine, so `rankPool` applies the path under any candidate knobs and
`make tune` re-ranks without searching again.

### Layered expansion

When `layeredExpansion` is on, hybrid `expandGraph` walks by layer. From a
page whose layer is on rung `ℓ`, one hop follows:

- the page's entities on rungs `ℓ − 1`, `ℓ` and `ℓ + 1`;
- the membership parents and children of its rung-`ℓ` entities, when they
  fall on those rungs;
- its `concept` entities, whatever `ℓ` is (decided before phase 1). Tags and
  teams cut across layers.

A `concept` page walks every rung, as today. **The hub cut applies at every
layer:** an entity named by more than `HUB_ENTITY_PAGES` (12) readable pages is
not walked, whether it is a service, a component or a tag. One threshold, not
one per layer: a per-layer table would be four knobs nobody can tune.

So an `interface` hit (one operation) reaches `component`, `interface` and
`code` pages and never a page linked only through a `service:` key, which is
two rungs up. `relationTypes` filters the edges first, as now. Entities
attached to the hits are unchanged.

The walk moves into a pure function (`search/expansion.ts`) so it can be
specified without stores. The flat walk stays the default, and its output is
unchanged.

### What a result carries

- `layer`: the page's layer, from its edges in the same read (as of `asOf`,
  if given). Absent for a page with no entities.
- `communityPath`: the titles of the readable communities containing the page,
  coarsest first. Absent when there are none, and under `asOf`.

Both are filled for every search that returns results. The cost is one edge
read restricted to the result pages, plus the community read the prior shares.
The atlas's budget keeps that to at most `COMMUNITY_MAX_PER_RUN` rows, and when
no communities are built (production today) it comes back empty.

The Ask's `search_knowledge`, MCP `knowledge_search` and the agent tools pass
both through, so a model sees where a hit sits.

## The invariants

- **Withheld whole, up the tree.** A community contributes only when the
  reader may open every page beneath it. Because `members` holds every page
  beneath, an ancestor of a withheld community is withheld too, and a hidden
  page's summary never boosts a visible one. `CommunitiesService` stays the
  one place that decides, for the overview, the colouring, the prior and
  `communityPath` alike.
- **`asOf` skips the prior and `communityPath`**, because communities describe
  only the current graph. A search with `asOf` ranks the same whether the
  prior is on or off. Layers are derived from keys, so `layer` and layered
  expansion still apply as of a date.
- **Empty settings rank exactly as today.** `communityPriorWeight` null means
  0, and `layeredExpansion` null means off. At those values the candidate
  pool, the fusion, the weights and the order are unchanged, query for query,
  and the parity spec replays one search through `rankPool` both ways. The new
  result fields add information and move nothing.

## Settings and knobs

Three sparse columns on `knowledge_health_settings`, each null meaning the code
default, editable beside the other search knobs on `/knowledge-health`
(feature [40](40-knowledge-health.md)):

| Setting | Default | `make tune` axis | Grid |
| --- | --- | --- | --- |
| `communityPriorWeight` | 0 (off) | yes | 0, 0.1, 0.2, 0.3, 0.5, 0.75, 1 |
| `communityPriorFloor` | 0.5 | yes | 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7 |
| `layeredExpansion` | off | no | — |

`layeredExpansion` is not a tuner axis, because the backtest measures ranked
hits and the walk only fills `related`. It is switched on by a person after
reading what it returns. Nothing switches on by deploying.

## Backtest

`make backtest ARGS="--generate"` reports a **broad-query set** beside the known-item one:

- **Queries.** Each readable community's title, at every level. They are
  generated without a model, so the set is reproducible.
- **Expected.** The community's member pages.
- **Metric.** recall@5 = |top 5 ∩ members| / min(5, |members|).

`--with '<json>'` overrides the knobs for one run, so the acceptance check
runs both sets before the prior (weight 0) and after the tuned knobs, in the
same session on the same data: broad recall@5 must rise, and known-item
recall@1 must not fall. `make tune` scores candidates on the broad set beside the
feedback set, under the known-item constraint it already has.

It runs on dev data, with bge-m3 served by the Mac mini's Ollama, one backtest
at a time, because ArcadeDB runs out of memory with two.

### Measured (2026-10-23)

- **Empty settings rank as before.** `--generate` on the demo workspace (35
  pages) against `dev` before the milestone (ba5ee72b) and after phase 5 gave
  the same 35 searches: identical documents, chunks and scores, compared
  event by event in the backtest stream. Recall@1 was 40.0% and recall@10
  68.6% on both.
- **The prior's gain is not measured yet.** The atlas could not build
  communities on dev data: the configured gen-api model answered every
  summary with a policy block, and gen-api was then unreachable. To measure:
  1. Run the atlas with `COMMUNITY_SUMMARIES_ENABLED=true`.
  2. Run `make backtest ARGS="--generate"`.
  3. Run `make tune`.
  4. Run `make backtest ARGS="--generate --with '<proposal>'"`.
- **End to end:** `graph-layers.e2e-spec.ts` seeds a two-level tree over an
  open page and a restricted one, and searches as two non-admin editors. The
  admitted reader's open page rises with a `communityPath`. The excluded
  reader's results are identical with the prior on and off, with no path and
  an empty level-1 overview.

## Decisions

**Membership from declaring pages, at read time.**

- *Co-mention* ("any page naming both") was rejected: one hub page would link
  every component to every service.
- *A new `PART_OF`/`CONTAINS` edge type* was rejected. It would join the
  SQL-interpolated allowlist, and as a stored fact it would need writers, a
  backfill, and a rule for which page owns it.
- *A `service` column on `component_declarations`* was rejected, because it
  changes how a component page is authored for a fact the page usually
  already states.

**Layers derived, not stored.** A layer property on `Entity` would be a second
answer to what the key already says, and would need a backfill whenever the
catalogue changed.

**A prior, not a mode.** Feature 57's "no global search mode" stands: routing
a query to a level is a model's job and belongs to Ask. The prior is
arithmetic on an embedding search already has.

**One path, not a top-n blend.** The best match at each level gives the
"coarsest, then its children" shape the issue asks for, and keeps the boost
explainable from `communityPath`. Blending several areas is a follow-up if the
broad set shows it is needed.

**`global_overview` defaults to level 0.** Without `level` it returns what it
returns today. A model asks for a coarser level explicitly, and the tool
description says when to.

**Three levels, constant, at halving resolution.** "Repeat until modularity
stops rising" never rises at resolution 1 after a converged level 0, so each
level halves γ instead. A fourth level would be at γ = 0.125, which merges
nearly everything into one root that answers no question.

## Phases

One PR each into `dev`:

1. This document (#493).
2. **Community hierarchy** (#494): the aggregation in `agents/communities.ts`
   (`level`, `parentId`, deterministic, with a spec); `Community.level` /
   `parentId` and reads by level in `GraphService`; upper-level summaries and
   the shared budget in `AgentExecutor`; withheld-whole up the tree and
   `level` in `CommunitiesService.overview` and
   `GET /v1/graph/communities`.
3. **Entity layers** (#495): `entityLayerFor`, `entityTypesOfLayer` and
   `pageLayerOf` in contracts (buildless package constraints apply);
   `layerParents`; `layer` on the entity nodes of the workspace and document
   graphs.
4. **Search** (#496): the prior in `rankPool` and `SearchService`, the knobs in
   `SearchKnobs`, `knowledge_health_settings` and `/knowledge-health`; layered
   `expandGraph`; `layer` and `communityPath` on `SearchResult`; the tuner
   axes; `make api-client`.
5. **Backtest** (#497): the broad-query set, reported beside the known-item set and
   scored by `make tune`; `--with`; the non-admin e2e.
6. **Agents, MCP and docs**: pass-through in the Ask read tools and
   `knowledge_search`; `level` on both overview tools; `skill.ts` and the
   atlas instructions; [04](../architecture/04-search-graph.md)
   §Communities and §Limits; the note in [57](57-temporal-graph.md).

## Out of scope

- A model call at query time: query rewriting, or routing to a level. That is
  Ask's job.
- The community hierarchy as of a past date or a release tag.
- A graph view that zooms by level or colours by layer, until the data exists.
- Turning on `COMMUNITY_SUMMARIES_ENABLED` in production. That is a release
  step, taken once the backtest says so.
- Document hierarchy (`documents.path`) entering the graph. Features 08 and 11
  stand.
