# 02 — Persistence & revisions

PostgreSQL is the transactional truth: documents, branches, the immutable
revision DAG, the ingestion outbox and the diff cache. Bytes live in MinIO and
facts live in ArcadeDB, but neither is authoritative about _what a document is_
or _what its history was_.

## What this is

A document is a stable identity with a tree of **immutable revisions** hanging
off it. Nothing is ever edited in place: a change writes a new revision, points
it at its parents, and advances a branch head. That is what makes compare,
merge, historical fact queries and rollback all reduce to graph walks over rows
that never change.

## Data model

| Table                 | Holds                                                              |
| --------------------- | ------------------------------------------------------------------ |
| `documents`           | Identity, workspace, project, category, `parent_id` nesting         |
| `document_branches`   | Named branches, each with a `head_revision_id`                      |
| `document_revisions`  | Immutable revisions, each with a **`branch_id`**                    |
| `revision_parents`    | The DAG edges, with `parent_order`                                  |
| `revision_diffs`      | Cached compare results, keyed by from/to and format                 |
| `ingestion_jobs`      | The outbox — see [03 — Ingestion](03-ingestion.md)                   |

**`document_revisions.branch_id` is a divergence from
[plan.md §4](../../plan.md)**, whose DDL models the branch→revision relationship
only through `document_branches.head_revision_id`. In the code every revision
knows its own branch, because `finalizeRevision` has to advance _that_ branch's
head rather than infer which branch a write belonged to. Rows written before the
column existed fall back to the default branch.

### Status lifecycle

```
draft → finalized → indexing → indexed | failed
```

`content_hash` and `s3_version_id` are **nullable until finalize** — a draft
revision exists before its bytes do.

### Dedupe is per-branch

`@@unique([documentId, branchId, contentHash])`. Deliberately not per-document: a
merge revision legitimately repeats the source head's content on the target
branch, and a dedupe spanning branches would refuse to record that the merge
happened. It never spans documents.

### Object layout

```
workspaces/{ws}/documents/{doc}/revisions/{rev}/source.md
workspaces/{ws}/documents/{doc}/revisions/{rev}/normalized.json
```

The bucket is versioned, and clients upload directly via presigned PUT — **the
API never streams file bodies**.

## Branching

`POST /v1/documents/:id/branches` forks from a finalized revision, defaulting to
the default branch's head. `GET /v1/documents/:id/revisions` returns the DAG,
with `parentRevisionIds` read from `revision_parents`.

`parent_order` carries meaning that the column definition alone does not:
**order 1 is the target head, order 2 the source head**. A `merge-commit`
strategy writes both; `squash` writes a single parent. Both copy the source
head's bytes and then run the ordinary finalize → outbox → reindex path, so a
merged revision is indexed by exactly the same code as a hand-written one. See
[05 — Merge & review](05-merge-review.md) for the gates around that.

## Compare

`GET /v1/documents/:id/compare?from=&to=&mode=direct|merge-base`, owned by
`CompareService`.

- `direct` diffs the two revisions as given.
- `merge-base` first finds the **nearest common ancestor by BFS over the parent
  map**, then diffs against that — the question a reviewer actually asks, which
  is "what did this branch change", not "how do these two rows differ".

Line diffs come from the `diff` package (`structuredPatch`). **Only finalized
revisions are comparable**; a draft has no bytes to compare.

Results are cached in `revision_diffs`. Because revisions are immutable, **the
cache can never be stale**, so there is no invalidation path and none is needed.

Two further projections ride on the same endpoint and the same cache:

- **`?structural=`** — a path-level diff of JSON/YAML bodies, or of a markdown
  document's frontmatter (`src/documents/structural-diff.ts`), cached under the
  format `structural-json`. It answers "which field changed" rather than "which
  line moved".
- **`?semantic=`** — a graph-projection diff: the per-revision frontmatter
  relation edges, plus `GraphService.revisionEmbeddingShift`. It answers "what
  does the knowledge base now believe that it did not before".

## Optimistic concurrency

`POST /v1/documents/:id/revisions` accepts **`If-Match: <expected-head-revision-id>`**.
If the branch head has advanced since the client read it, the write is refused
with a 409 carrying a `comparisonUrl` — the conflict is reported as a place to
look, not merely as a failure. The MCP equivalent is the `baseRevisionId`
argument, since a stdio tool call has no HTTP headers.

## Routes

```
POST   /v1/documents                      create (requires projectId)
POST   /v1/documents/:id/uploads          presigned PUT
POST   /v1/documents/:id/.../finalize     hash, dedupe, finalize, enqueue
POST   /v1/documents/:id/revisions        new revision   (If-Match)
GET    /v1/documents/:id/revisions        the DAG
POST   /v1/documents/:id/branches         fork
GET    /v1/documents/:id/compare          direct | merge-base, ?structural= ?semantic=
GET    /v1/documents/:id/content          full markdown + frontmatter
GET    /v1/documents/:id/facts            ?at=<rev> — snapshot via newest asserting ancestor
GET    /v1/documents/:id/facts/timeline   introduced / removed revisions
```

## Limits

- **Three-way content merge is future work.** Merging is fast-forward-preconditioned
  instead; see [05 — Merge & review](05-merge-review.md).
- The diff cache grows without bound. Nothing prunes `revision_diffs`, which is
  acceptable precisely because entries can never be wrong, but it is not free.
- History queries read the revision-scoped fact set kept by every indexed
  revision, so a revision that never indexed has no facts to snapshot.
