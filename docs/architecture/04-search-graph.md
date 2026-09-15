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
only guarantee that a query cannot cross a tenant boundary.

## Vector search

Phase 1 similarity is **cosine computed in Node**, inside
`GraphService.searchChunks`. That is deliberately unclever: it keeps the vector
store swappable, and moving to native HNSW should touch only that one method.

## BM25, behind a provider token

Full-text mirrors the embeddings pattern exactly:

| `FULLTEXT_PROVIDER` | Behaviour                                                |
| ------------------- | -------------------------------------------------------- |
| `none` _(default)_  | Vector only. `mode: 'keyword'` silently falls back to it |
| `opensearch`        | Plain-HTTP client, no SDK; `make infra-up-opensearch`     |

The worker mirrors chunks into the index as a **non-fatal step 6b** — a failure
to index for keyword search must never fail a revision that is otherwise
retrievable. Hybrid ranking fuses the vector and BM25 orderings by **reciprocal
rank fusion**; `mode: 'keyword'` is BM25-only.

## Filters are applied after ranking

`filters.categories` and `filters.projectIds` are resolved **post-ranking against
PostgreSQL**, under a 5× candidate over-fetch. The graph holds semantic facts,
not UI structure, so project and category membership are not modelled as edges —
which means filtering cannot happen during the graph query and must happen after
it, with enough candidates over-fetched that a filtered page is still full.

## The graph is bipartite

**Edges always run Document → Entity**, with a `doc:<id>` node convention, and
BFS runs **in Node** over `GraphService.getWorkspaceRelationGraph` using the pure
helpers in `src/graph/graph-walk.ts`. One entity hop is therefore two BFS hops.

**This diverges from [plan.md §6](../../plan.md)**, which models
`(Entity)-[:DEPENDS_ON]->(Entity)` directly and performs multi-hop traversal in
Cypher (`*1..2`). Read plan.md §6 as design intent; the bipartite projection is
what exists. Without this note the plan reads as simply wrong against the code.

## Fact classes and inference

Four provenance classes share one edge table, ordered by how much a human
vouched for them ([plan.md §5](../../plan.md)):

| `extractor`   | Source                                   | Confidence   |
| ------------- | ---------------------------------------- | ------------ |
| `explicit`    | `relations[]` on create, or the relations endpoint | 1   |
| `frontmatter` | Parsed from the document — see [03](03-ingestion.md) | 1 |
| `inferred`    | The LLM extractor                        | clamped      |
| `curated`     | A human confirming or correcting a fact  | 1            |

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

## Security

Edge type names are **SQL-interpolated**, so every type is validated against
`RELATION_EDGE_TYPES` in `GraphService`. **Never widen that list without keeping
the allowlist check** — it is the only thing standing between a relation type and
injection.

Operator access to the raw graph is a separate, audited path; see
[06 — Auth & ACLs](06-auth-acl.md).

## MCP

`knowledge_search`, `knowledge_find_relations`, `knowledge_impact_analysis`,
`knowledge_trace_relation`, `knowledge_get_historical_context`.

## Limits

- Cosine in Node is O(chunks) per query; it is correct, not fast, and is the
  first thing to replace under load.
- The 5× over-fetch is a heuristic. A filter matching very few documents in a
  large workspace can still return a short page.
- Entity keys are free-form strings (`service:identity`); nothing normalises two
  spellings of the same entity into one node.
