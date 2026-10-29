---
title: The graph, relations and entities
section: Concepts
summary: Four classes of fact, where each one comes from, and why an inferred edge can never overwrite a human one.
---

# The graph, relations and entities

## What is in the graph

ArcadeDB holds the semantic layer: `Document`, `DocumentRevision` and `Chunk` vertices,
`HAS_REVISION` and `HAS_CHUNK` edges, the chunk embeddings, and — the interesting part —
**typed relation edges** from documents to entities.

The graph is **bipartite**: edges always run *Document → Entity*, and a document node is
addressed as `doc:<id>`. Entities are plain keys like `service:identity` or
`queue:orders`. There is no direct document-to-document edge, which is why one "entity
hop" is two hops in a traversal: page → entity → page.

## Four classes of fact

Every edge records where it came from, and the source decides what may overwrite it:

| Extractor | Source | Confidence | Overwritten by |
| --- | --- | --- | --- |
| `frontmatter` | `relations:` / `tags:` in the page's own frontmatter | 1 | re-indexing that revision |
| `explicit` | the API — `relations[]` on create, or `POST /:id/relations` | 1 | re-posting the same `(document, target, type)` |
| `curated` | a person confirming or correcting an edge in the UI | 1 | a person |
| `inferred` | an LLM reading the text | the model's, clamped to a floor | re-extraction — but never over a curated or explicit edge |

That last row is the rule that makes inference safe to turn on. Re-extraction deletes only
the *inferred* edges of the revision being reindexed, and skips any `(type, target)` a
human already covered. A model cannot quietly undo a correction.

Inferred edges also carry evidence: the chunk they came from and the snippet that
supports them, so a claim in the graph can be traced back to the sentence that produced
it.

## Declaring relations by hand

The deterministic path is frontmatter, and it needs no AI:

```yaml
---
title: Identity service
tags: [security, platform]
relations:
  - type: DEPENDS_ON
    target: service:postgres
  - type: DESCRIBES
    target: service:identity
---
```

Relation type names are interpolated into graph queries, so they are checked against a
fixed allowlist before they get anywhere near one. An unknown type is rejected rather
than escaped. `TAGGED_WITH` is not in the hand-writable set: tag edges are synthesised
from the `tags:` key, so writing one as a relation is refused.

## Letting the assistant maintain them

Frontmatter is a page's own text, so changing it is a revision — and a revision an AI
authored is a proposal, never a fact. Ask the assistant to add or remove a relation and
it opens a **merge request** against the page; only `relations:` and `tags:` are touched,
and every other key is carried through untouched. Nothing reaches the default branch
without somebody merging it.

The **Cartographer** agent does the same job unattended. It reports two things: pages
carrying an inferred edge nobody has confirmed — a claim the graph holds and the page
does not — and connections the pages support but nothing has spotted. Its findings are
proposals; **Apply relations** turns one into that same merge request.

One caveat worth knowing: rewriting the block re-serializes all of it, so neighbouring
keys can come back reformatted. The content is unchanged — it is a cosmetic diff, and
the merge request says so.

`DESCRIBES` is the load-bearing one: it says *this page is the documentation for that
entity*, which is what makes impact analysis and dependent reindexing work.

## Traversal

Because the graph is bipartite and small per workspace, walks happen in Node over a
fetched relation graph rather than as recursive database queries:

- `GET /v1/entities` — every entity in the workspace, with how many pages reference it.
- `GET /v1/entities/:key/neighbors` — what sits one hop away.
- `GET /v1/entities/trace` — the path between two entities, and the pages that justify
  each step.
- `POST /v1/entities/:key/impact-analysis` — **dependents**: pages that reference the
  entity, then the entities *those* pages describe. **Dependencies**: the same walk
  reversed. This is the "what breaks if this changes" question.

## Search that walks the graph

Pass `expandGraph: { depth, relationTypes }` to search and results come back with their
entities attached, plus a `related[]` list of pages reachable only *through* the graph —
pages that never use your words but document something your results depend on. The
connecting edges come back as evidence, so a related hit can explain itself.

## Reindex cascades

When a page is reindexed, pages that reference the entities it **describes** are queued
for reindexing too — one level deep, never recursive, capped by `DEPENDENT_REINDEX_MAX`.
Those jobs are marked `reason: 'dependent-reindex'` and never cascade again, which is what
keeps a well-connected workspace from reindexing itself forever.

## Historical facts

Each indexed revision keeps its own fact set permanently, so the graph can answer
questions about the past:

- `GET /v1/documents/:id/facts?at=<revision>` — what this page asserted at that point,
  resolved through the newest asserting ancestor.
- `GET /v1/documents/:id/facts/timeline` — when each fact was introduced and when it was
  removed, which doubles as an audit of deletions.
