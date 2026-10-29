---
title: Search
section: Concepts
summary: Vectors, BM25, the fusion between them, and the filters that run after ranking rather than before it.
---

# Search

`POST /v1/search` is one endpoint with three modes and a graph on the side.

## The three modes

**Semantic (default).** The query is embedded and compared against chunk vectors by cosine
similarity. This finds the passage that answers a question even when it shares no words
with it. Chunking is heading-aware, so a hit is a section rather than an arbitrary window,
and every result cites its document, revision and chunk.

**Keyword** (`mode: 'keyword'`). BM25 over an OpenSearch index the worker mirrors chunks
into. Exact terms, identifiers, error strings — the things vectors are bad at. Optional:
without `FULLTEXT_PROVIDER=opensearch` configured, keyword mode falls back to vector
search rather than returning nothing.

**Hybrid.** Both, fused with reciprocal rank fusion — each engine's ranking contributes,
neither's scores have to be made comparable. This is the mode to reach for by default when
the keyword index is available.

## Filters run after ranking

`filters.projectIds`, `filters.categories` and `filters.tags` are applied against
Postgres **after** the ranking, over a candidate set fetched five times larger than the
requested limit. Filtering first would mean either pushing tenant-shaped predicates into
the vector store or ranking a set that had already been cut; over-fetching keeps the
ranking honest and the filter exact.

The consequence worth knowing: a filter that matches very few pages in a large workspace
can return fewer results than the limit even though more exist. Narrow the query, or the
scope, rather than raising the limit.

## Graph expansion

```jsonc
{
  "workspaceId": "…",
  "query": "why do orders stall",
  "expandGraph": { "depth": 1, "relationTypes": ["DEPENDS_ON"] }
}
```

Each hit comes back with the entities it touches, and the response gains `related[]` —
pages found by walking outward from the results rather than by matching the query. The
edges that connected them are included, so the UI (and an agent) can say *why* a page is
in the answer.

## Where it shows up

- The **search sheet** in the top bar (`/` or `⌘K`) — as-you-type, scoped to the active
  workspace.
- `/search` — the full page, with filters.
- `knowledge_search` over MCP, with `projectIds` and `tags`.
- The **assistant**, which uses the same service as a tool and cites what it read.

## Keeping the index true

Each revision records the embedding signature — `provider:model:dim` — it was indexed
with. A sweeper compares branch heads against the current configuration and reindexes the
ones that have drifted, ten per pass, so changing the embedding model does not silently
leave half the workspace unsearchable. It also re-queues jobs stuck in `running` and
retries failures under a cap. Manual controls live at `GET /v1/ingestion/stale` and
`POST /v1/ingestion/reindex`.
