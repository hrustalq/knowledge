---
title: Documents, revisions and branches
section: Concepts
summary: Why every save is immutable, what a branch actually is, and the four states a revision passes through.
---

# Documents, revisions and branches

## A document is a name; a revision is the content

The `documents` row holds identity — title, category, parent, which project it is in. It
holds no text. Every version of the text is a **revision**: an immutable row pointing at
an immutable object in storage.

Nothing is ever edited in place. Saving a page creates a new revision; the previous one
stays exactly as it was, forever. That is what makes history, comparison, review and
"what did this page say in March" possible at all, and it is why the diff cache never
needs invalidating — two revisions can only ever differ one way.

## The lifecycle

```
draft ──finalize──▶ finalized ──worker claims──▶ indexing ──▶ indexed
                                                     │
                                                     └──▶ failed ──retry──▶ …
```

| State | Meaning |
| --- | --- |
| `draft` | the row exists and an upload URL has been handed out; the bytes may not have arrived |
| `finalized` | bytes are in storage, hashed and content-addressed; the branch head has advanced; indexing is queued |
| `indexing` | the worker has claimed it and is chunking, embedding and writing the graph |
| `indexed` | searchable, its relations are in the graph, its chunks are mirrored to the keyword index |
| `failed` | the pipeline threw; the sweeper retries it up to `STALE_MAX_ATTEMPTS` |

Finalize is the one moment that matters: hashing the bytes, deduping against the branch,
creating the revision and writing the ingestion job all happen in **one Postgres
transaction**. Either the revision exists with a job that will index it, or neither
exists. There is no state where a page is saved but invisible forever.

## Branches

A branch is a named pointer at a revision — the same idea git has. Every revision records
the branch it was created on, and finalizing advances *that* branch's head.

Forking is cheap: `POST /v1/documents/:id/branches` starts a branch at any finalized
revision (the default branch's head, unless you name another). Write on it, then open a
merge request to bring it back.

Content dedupe is deliberately **per branch** — the uniqueness key is
`(document, branch, contentHash)`. A merge revision legitimately repeats the source
head's bytes on the target branch, so a repo-wide dedupe would refuse the merge. It never
spans documents either: two pages may say the same thing.

## The revision DAG

Revisions have parents, stored in their own table, so history is a directed acyclic graph
rather than a list:

- A normal save has **one** parent: the previous head.
- A **merge commit** has **two**: the target head first, the source head second.
- A **squash** merge has one, so a long branch collapses into a single node.

That structure is what `?mode=merge-base` compares against: the nearest common ancestor of
two revisions, found by walking parents breadth-first, so a comparison shows what a branch
changed rather than everything that happened on both sides since they diverged.

## Comparing

`GET /v1/documents/:id/compare?from&to` answers three different questions:

- **Line diff** — the default. Text in, patch out, cached in Postgres.
- **Structural** (`?structural=`) — a path-level diff of JSON or YAML bodies, or of a
  markdown page's frontmatter. It answers *which fields changed*, not which lines did.
- **Semantic** (`?semantic=`) — a graph-projection diff: the relation edges each revision
  asserted, plus how far the page's embedding moved. This is what tells you a rewrite
  changed the meaning rather than the wording.

Only finalized revisions are comparable, and every result is cached permanently, because
immutable inputs cannot produce a different answer later.

## Concurrency

Two people writing to one branch is caught, not merged silently. Send
`If-Match: <expected-head-revision-id>` on `POST /v1/documents/:id/revisions` and you get
a 409 with a comparison link if the head has moved since you read it. Over MCP the same
guard is the `baseRevisionId` argument.
