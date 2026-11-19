# 12 — CouchDB as a replacement for PostgreSQL and MinIO

**Status:** decided, 2026-11-19

**Issue:** [#1252](https://github.com/hrustalq/knowledge/issues/1252)

**Decision:** **reject** both a wholesale storage replacement and a CouchDB/PouchDB
offline-sync edge today.

PostgreSQL remains the transactional truth and MinIO remains the versioned object
store. No follow-up implementation issues are opened because the verdict is
reject. Reconsider only when offline access to a whole workspace or multi-master
writes is an accepted product requirement, rather than a way to remove one
service. Such a requirement would need a separate design for permissions,
conflicts and publish semantics before a storage prototype.

## What was evaluated

The question is not whether CouchDB can store JSON and files. It can. The
question is whether it can preserve the responsibilities documented in
[02 — Persistence & revisions](02-persistence-revisions.md),
[03 — Ingestion](03-ingestion.md), [05 — Merge & review](05-merge-review.md),
[06 — Auth & ACLs](06-auth-acl.md) and
[58 — Usage analytics](../features/58-usage-analytics.md), while keeping the
upload contract in [`StorageService`](../../apps/api/src/storage/storage.service.ts).

The decisive existing invariants are:

- finalize atomically claims a revision, advances the expected branch head,
  updates the project commit and shared draft, and creates the `ingestion_jobs`
  outbox row;
- merge atomically writes the merged revision and its parents, advances the
  target branch and closes the merge request, under a branch-row lock;
- page reads combine workspace roles, resource grants and the denormalized
  `restricted_by` chain through one `AccessScope`;
- browsers upload directly to MinIO with a presigned PUT; the API never streams
  file bodies;
- finalized reads pin both the object key and the MinIO version whose bytes were
  hashed.

CouchDB's `_rev` tree is a replication and optimistic-concurrency mechanism, not
the application's immutable revision DAG. CouchDB documents that compaction
discards non-leaf document bodies and that conflicting revisions require
application-specific merging. Our `document_revisions`, `revision_parents`,
branches and merge requests would therefore remain application data even after a
migration. See [Replication and conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html).

## Responsibility-by-responsibility

| Current responsibility | Can CouchDB hold it? | Cost and consequence |
| --- | --- | --- |
| Documents, projects, workspaces and their settings | **Yes, as JSON, but not as a drop-in model.** | The current schema has 151 Prisma models. Relations, uniqueness, cascades and guarded updates must be redesigned as document aggregates plus Mango/view indexes. Large aggregates hit contention and the document-size ceiling; small aggregates reintroduce multi-document consistency problems. |
| Immutable revisions, branches and the revision DAG | **Only as application-defined documents.** | CouchDB `_rev` cannot replace immutable page history. A finalize or merge touches a revision, parent edges, a branch head and often project/draft state, which cannot commit atomically across those documents. Packing a page's whole history into one document would serialize every write and eventually approach the 8 MB JSON limit. |
| The ingestion outbox | **Not with the current atomic guarantee.** | A revision and job could share one denormalized document only by also moving every other finalize participant into that same aggregate. `_bulk_docs` is non-atomic, and a changes feed would be a new relay design, not preservation of the existing transaction. The worker's guarded job/revision completion writes have the same problem. |
| Merge requests and review state | **Not without redesigning merge atomicity.** | The merged revision, target head and MR status must move together. CouchDB cannot reproduce the branch-row lock and transaction. Conflict winner selection is also not the product's explicit 3-way merge and review flow. |
| Permissions and SQL such as `visibilitySql` | **Data yes, current enforcement no.** | Mango and views can index grants and `restricted_by`, but there are no SQL joins or ad-hoc SQL predicates. Role, group, grant, ancestor and resource lookups would need denormalization or multiple requests, with new consistency and fail-closed tests for every reader. Replicated conflicts would make authorization state another application-level merge problem. |
| Analytics event rows and rollups | **Events and simple aggregates yes, current reports no.** | Append-only events fit documents, and map/reduce fits counts. The current read-time reports also join events to current pages and ACLs, collapse repeated searches with CTEs, calculate CTR and percentiles, and answer never-read/dead-page predicates. Those become purpose-built views plus application queries, with index rebuild and storage costs. |
| Raw bytes and object versioning | **Attachments yes, MinIO semantics no.** | Attachments support binary bodies and range requests, and the 8 MB JSON limit excludes them. But each attachment write revisions its parent document, non-leaf bodies are not a permanent version history, and there is no S3-compatible `VersionId`, server-side key copy or versioned-prefix purge contract to preserve. |

## Vendor constraints checked

These are properties of the documented CouchDB model, not missing configuration
in the current deployment:

- **Atomicity is a single-document write.** The bulk API explicitly says
  `_bulk_docs` is non-atomic and is not an ACID-like transaction mechanism.
  Source: [Bulk Documents Transaction Semantics](https://docs.couchdb.org/en/stable/api/database/bulk-api.html#bulk-documents-transaction-semantics).
- **The default `max_document_size` is 8,000,000 bytes.** It is measured on the
  serialized Erlang JSON representation and excludes attachments. Source:
  [Base CouchDB Options](https://docs.couchdb.org/en/stable/config/couchdb.html#couchdb-max_document_size).
  This is not a reason to put revision bodies in JSON: current defaults allow
  50 MiB revisions, 25 MiB attachments and 200 MiB memo audio.
- **Attachment writes create a new parent-document revision.** Deletes do too;
  revisions belong to the parent, not to individual attachments. Source:
  [Attachments API](https://docs.couchdb.org/en/stable/api/document/attachments.html).
- **There is no S3-style presigned direct-upload operation.** The documented
  upload is an authenticated `PUT /{db}/{docid}/{attname}` carrying the body and,
  for an existing document, its current `_rev`. A browser-direct design would
  therefore need CouchDB credentials or a new short-lived upload authorization
  service; routing every body through the existing API would break an explicit
  architectural invariant. Source: the same [Attachments API](https://docs.couchdb.org/en/stable/api/document/attachments.html#put-db-docid-attname).
- **Queries are Mango or materialized views, not PostgreSQL.** Mango provides
  declarative selectors and indexes; map/reduce views provide precomputed keys
  and aggregates. Neither executes the existing joins, CTEs, row locks or
  ad-hoc SQL. Sources: [Mango `_find`](https://docs.couchdb.org/en/stable/api/database/find.html)
  and [Views](https://docs.couchdb.org/en/stable/ddocs/views/intro.html).
- **Replication does not remove conflict handling.** CouchDB retains conflicting
  leaves, chooses a deterministic winner for ordinary reads and views, and asks
  the application to merge. Compaction can remove the old bodies needed for a
  three-way merge. Source: [Replication and conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html).

## What would be gained, and whether the product needs it

CouchDB offers mature incremental replication. [PouchDB](https://pouchdb.com/)
can keep a browser-local copy offline and synchronize it with CouchDB later.
That is a real capability and the strongest reason to consider this stack.

It does not match a missing requirement today:

- real-time co-editing already keeps an IndexedDB Yjs copy while the socket is
  down and merges edits on reconnect, including reset generations that stop a
  stale offline copy entering a discarded draft
  ([feature 56](../features/56-realtime-coediting.md#offline));
- the service worker deliberately caches application code and an offline page,
  never workspace data ([10 — Caching](10-caching.md#the-service-worker));
- no feature document asks for a fully offline workspace, offline search and
  permissions, or writes accepted by multiple masters.

A PouchDB edge would therefore add a second offline model beside Yjs rather than
remove one. It would also require local ACL filtering, conflict UI, publish-mode
rules, attachment synchronization and reconciliation with the outbox and search
stores. Native replication does not supply those product semantics. The partial
verdict is consequently reject as well: do not add CouchDB only for offline sync.

## Migration size if adopted anyway

**Extra-large: an application-wide persistence rewrite and production data
migration, not a storage adapter.** A snapshot of `dev` for this record contains:

- 151 Prisma models and 197 SQL migrations;
- 67 `$transaction` textual occurrences across 41 API source files;
- 173 `$queryRaw`/`$executeRaw` textual occurrences across 73 API source files;
- the S3 contract in `StorageService`: presigned PUT/GET, version-pinned reads,
  server-side copies, byte/file downloads, retention pruning and recursive
  version purges.

The occurrence counts are scale indicators, not distinct call-site estimates.
They cover documents, auth, connectors, publishing, memory, chat, analytics and
background jobs, so this is not confined to the responsibilities above.

An adoption program would need at least four coordinated workstreams: document
and index modeling for every Prisma consumer; new consistency/locking protocols
for every transaction; a new direct-upload and object-lifecycle contract; and an
export/import, reconciliation, rollback and full security-regression plan. It is
a multi-quarter, high-risk program with no demonstrated product payoff. Removing
one infrastructure service does not compensate for that cost or for weaker fits
at the system's most important invariants.

## Reopening criteria

Reopen the question only with a concrete requirement for whole-workspace offline
use or multi-master operation and an owner for its conflict and permission UX.
Evaluate a narrow PouchDB-compatible edge against Yjs and the existing revision
DAG at that point. Do not reopen it merely to consolidate PostgreSQL and MinIO.
