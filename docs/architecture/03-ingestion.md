# 03 — Ingestion

## What this is

The write path from `finalize` to `indexed`: the outbox that guarantees the job
exists, the worker pipeline that turns markdown bytes into chunks, vectors and
deterministic graph edges, and the sweepers that re-run any of it when a job
dies or the embedding space moves underneath it.

The worker is a **second entrypoint of `apps/api`**, not a separate app —
`src/worker.main.ts` creates an application context over `WorkerModule` with no
HTTP server, against `src/main.ts`'s Nest app. That is why the module split
below is load-bearing rather than tidy: the same classes are compiled into both
processes and only the registration decides which one consumes jobs.

Revision storage and the compare layer are [02 — Persistence and the revision
DAG](02-persistence-revisions.md); the retrieval side of what this layer writes
is [04 — Search and the knowledge graph](04-search-graph.md).

## Why the enqueue is an outbox

A revision that is `finalized` in PostgreSQL but has no queued job is invisible
work: nothing will ever index it and nothing will ever notice. `plan.md` §5
asks for an outbox or a reliable enqueue-after-commit, and
`DocumentsService.finalizeRevision` implements both halves.

The `ingestion_jobs` row (`status: 'queued'`) is created **inside the same
`prisma.$transaction`** that flips the revision to `finalized` and advances the
branch head, so the job either exists with the revision or neither does. The
BullMQ enqueue then happens post-commit through
`this.prisma.onCommit(() => this.ingestion.enqueue(job.id))` rather than as a
bare call after the `await` — an outer wrapping transaction would otherwise be
able to hand the worker a job id whose row has not committed yet.

`IngestionProducer.enqueue` (`apps/api/src/ingestion/ingestion.producer.ts`)
sets the BullMQ `jobId` to the `ingestion_jobs.id`, which makes a double
enqueue harmless: BullMQ dedupes on that id. Job options are `attempts: 3`,
exponential backoff from 2000 ms, `removeOnComplete: true`,
`removeOnFail: false`.

`OutboxSweeper` (`apps/api/src/ingestion/outbox.sweeper.ts`) closes the
remaining hole — a process that dies between commit and enqueue. Every 30
seconds (`setInterval(…, 30_000).unref()`, re-entrancy-guarded by a `running`
flag) it re-enqueues up to 20 rows still `queued` and older than 60 seconds,
oldest first. The delay is what keeps it from racing the normal path.

## The worker pipeline

`IngestionProcessor` (`apps/api/src/ingestion/ingestion.processor.ts`,
`@Processor(INGESTION_QUEUE)`) runs one revision per job. Its first act is the
idempotency guard — `if (jobRow.status === 'completed') return;` — so a
re-delivered job is a no-op rather than a second pass.

The steps are numbered in the source, and the numbers are referenced elsewhere
in the codebase, so they are worth keeping stable:

| Step  | What it does                                                            | `mark()`     |
| ----- | ----------------------------------------------------------------------- | ------------ |
| 1     | Fetch raw bytes — `storage.getObjectText(revision.s3Key)`                | `fetch`      |
| 2     | Parse with gray-matter (`matter(raw)`); non-markdown/non-`text/*` is rejected | —       |
| 3     | Normalize via `splitMarkdown`, persist `normalized.json` beside the source | `normalize` |
| 4     | Chunk — `chunkSections(sections)`                                        | `chunk`      |
| 5     | Embed — title + heading breadcrumb + body, in slices of 32               | `embed`      |
| 6     | Index into the graph store — `graph.upsertRevisionChunks`                | `graph`      |
| 6b    | Optional BM25 mirror — `fulltext.indexRevisionChunks`, non-fatal         | `fulltext`   |
| 7     | Deterministic relations — frontmatter facts                              | `relations`  |
| 8     | Inferred relations — the LLM extractor, non-fatal                        | `inferred`   |

Steps 6b and 8 are documented in [04](04-search-graph.md); everything else is
below.

After step 8 a single `$transaction` marks the job `completed` and the revision
`indexed`, stamping `indexed_at` and `embedding_model`. Only then does the
processor emit backtest telemetry, publish `revision.indexed`, and fan out
**one level** of dependent reindex — skipped entirely when
`payload.reason === 'dependent-reindex'`, which is what stops a cascade from
restarting itself. That fan-out is [feature 04](../features/04-dependent-reindex.md).

**Normalization and chunking** live in `apps/api/src/ingestion/markdown.ts`.
`splitMarkdown` walks a heading stack (`/^(#{1,6})\s+(.*)$/`) so every section
knows its ancestry; `chunkSections(sections, maxChars = 3200, overlapChars =
400)` greedily packs paragraphs to roughly 800 tokens on a chars/4 heuristic and
hard-splits a paragraph that exceeds the budget on its own. Those two numbers
are **default parameter values, not constants and not env vars** — the processor
calls `chunkSections(sections)` with no overrides. There are no chunking env
vars at all, and the embedding batch stride of 32 is likewise an inline literal.

The `normalized.json` sibling key is derived by regex
(`revision.s3Key.replace(/[^/]+$/, 'normalized.json')`) rather than through a
storage helper, which is worth knowing before renaming anything in the key
layout.

**What gets embedded is not what gets stored.** `chunkEmbedText(chunk,
documentTitle)` joins the document title, the heading breadcrumb
(`headingPath.join(' > ')`) and the chunk body, while the `text` written to the
graph store stays verbatim. A chunk deep in a page otherwise carries none of the
context that makes it findable.

Because the embedded text's _shape_ is part of the embedding space, the recipe
is versioned: `EMBED_RECIPE = 'r2'` in
`apps/api/src/embedding/embedding.provider.ts` is a segment of the signature the
drift sweeper compares against (below). Changing how text is assembled for
embedding without bumping the recipe leaves a corpus half-indexed under two
incompatible schemes with nothing able to detect it.

**Reindexing is idempotent by construction.** `GraphService.upsertRevisionChunks`
deletes the revision's `Chunk` rows and its `DocumentRevision` vertex before
recreating them, so running it twice converges rather than duplicating.

## Why embeddings are a DI token

`EMBEDDING_PROVIDER` is a real `Symbol` token declared in
`apps/api/src/embedding/embedding.provider.ts` and bound in
`embedding.module.ts` by a `useFactory` over `ConfigService`. The processor and
`SearchService` both inject the token, never a concrete class — the write side
and the read side are therefore guaranteed to embed through the same
implementation, which is the only thing that makes the vectors comparable.

Two implementations exist:

- **`stub`** (default) — `DeterministicStubProvider`, a hashed bag of words:
  FNV-1a per token, bucketed by `hash % dimension`, counted, L2-normalized, with
  a Unicode-aware tokenizer (`split(/[^\p{L}\p{N}]+/u)`). It is a **pipeline
  fixture, not a relevance baseline** — its own docstring says so — and it
  exists so the full e2e flow runs with zero external dependencies.
- **`openai-compatible`** — covers OpenAI, Ollama, LM Studio and vLLM.

Selection and configuration are validated by zod in `apps/api/src/config/env.ts`
and fail fast on boot:

| Env var               | Default  | Notes                                     |
| --------------------- | -------- | ----------------------------------------- |
| `EMBEDDINGS_PROVIDER` | `stub`   | `stub` \| `openai-compatible`             |
| `EMBEDDINGS_BASE_URL` | `''`     | conventionally ends in `/v1` — see below  |
| `EMBEDDINGS_MODEL`    | `''`     | falls back to the literal `default`        |
| `EMBEDDINGS_API_KEY`  | `''`     |                                            |
| `EMBEDDINGS_DIM`      | `384`    |                                            |

Note the spelling: the **env var is plural** (`EMBEDDINGS_PROVIDER`) while the
**DI token is singular** (`EMBEDDING_PROVIDER`). They are different names for
different things and are easy to conflate.

The `/v1` suffix on `EMBEDDINGS_BASE_URL` is a **convention, not a validation**.
The zod entry is a bare `z.string()` — no `.url()`, no regex — and the provider
simply appends `/embeddings`. A base URL missing `/v1` therefore fails at
request time with a 404 from the upstream, not at boot with a config error.

## Deterministic relations

`plan.md` §5 classes facts by confidence and source; this is the deterministic
class, and it is the only one that needs no model.

`extractFrontmatterFacts(frontmatter)`
(`apps/api/src/ingestion/relations.ts`) reads two frontmatter keys. `relations:`
yields typed edges directly. `tags:` yields `TAGGED_WITH` edges at synthetic
entities keyed `tag:<name>` with type `tag`, which is what makes a tag a
first-class graph citizen instead of a string column. Facts are de-duplicated on
`(type, target.key)`.

The module's local `RELATION_TYPES` set has **seven** members and deliberately
excludes `TAGGED_WITH`: it is the vocabulary an author may write in frontmatter,
which is narrower than the eight-member edge allowlist the graph accepts. A
`TAGGED_WITH` edge is something the parser derives, never something a page
declares.

Provenance is stamped by the caller rather than the parser — the processor maps
`{ ...f, extractor: 'frontmatter', confidence: 1 }` — so `relations.ts` stays a
pure function of the frontmatter. The `extractor` union across the whole system
is `'explicit' | 'frontmatter' | 'inferred' | 'curated'`.

Reindexing replaces only that revision's frontmatter edges:
`GraphService.replaceRevisionFrontmatterFacts` loops the edge-type allowlist
issuing `DELETE … WHERE documentId = :documentId AND revisionId = :revisionId
AND extractor = 'frontmatter'`. Scoping by both revision _and_ extractor is what
lets explicit, curated and inferred edges survive a reindex untouched.

**Explicit relations** come from a person or an API client, not from the
document body: `relations[]` on `POST /v1/documents`
(`@Access('editor', 'body')`) or `POST /v1/documents/:id/relations`
(`@Access('editor', 'document')`), both landing in
`DocumentsService.toFacts` with `extractor: 'explicit'` and confidence 1.
Re-posting replaces by `(documentId, targetKey, type)` —
`DELETE FROM ${fact.type} WHERE documentId = :documentId AND targetKey =
:targetKey AND extractor = 'explicit'`.

That replace is **not revision-scoped**, while the frontmatter one is. The
asymmetry is correct and deliberate: a frontmatter edge is an assertion made by
one revision's bytes, so it belongs to that revision; an explicit edge is an
assertion made about the document, so a later revision must not resurrect an
edge somebody deleted.

## Why the edge-type list is an allowlist

**Edge type names are interpolated into SQL.** ArcadeDB's SQL takes the edge
class as a bare identifier, so `CREATE EDGE ${fact.type} FROM … TO …` cannot
bind it as a parameter the way every other value in that statement is bound
(`:documentId`, `:key`, `:workspaceId`, `:revisionId`, `:targetKey`,
`:extractor`, `:confidence`, `:sourceChunkId`, `:snippet` are all parameters).

The type is therefore the **only** interpolated fragment in the statement, and
it reaches SQL by exactly two routes: iterating the constant itself, or passing
through the guard first.

```ts
export const RELATION_EDGE_TYPES = [
  'DESCRIBES', 'DEPENDS_ON', 'IMPLEMENTS', 'RELATED_TO',
  'OWNED_BY', 'SUPERSEDES', 'CONTRADICTS', 'TAGGED_WITH',
] as const;
```

```ts
private assertEdgeType(type: string): void {
  if (!(RELATION_EDGE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Relation type ${type} is not in the allowed edge-type list`);
  }
}
```

Both live in `apps/api/src/graph/graph.service.ts`, not in
`packages/contracts` — the allowlist has to sit next to the interpolation it
guards. `assertEdgeType` is called in `createRelationEdge` and in
`addExplicitRelations` before any type reaches a query string.

**Never widen `RELATION_EDGE_TYPES` without keeping the allowlist check.** A new
type added to the constant is safe; a code path that interpolates a type without
passing `assertEdgeType` is an injection, and it will look exactly like ordinary
graph code.

The second invariant belongs to the same file: **all graph queries must go
through `GraphService`**, because it is the single injection point for the
mandatory workspace predicate that `plan.md` §6's security note requires. The
predicate is resolved in PostgreSQL first and injected server-side; a
`workspaceId` filter written by a caller is not a substitute.

## Stale detection and reindex

`StaleSweeper` (`apps/api/src/ingestion/stale.sweeper.ts`) is registered only in
`IngestionWorkerModule`, so it runs in the worker and nowhere else. It ticks
every 5 minutes (`setInterval(…, 5 * 60_000)` — an inline literal, there is no
interval constant or env var), is gated by `STALE_SWEEP_ENABLED`, calls
`.unref()` so it never holds the process open, and guards re-entrancy with a
`running` flag. Each pass does three unrelated jobs, each capped at 10 rows:

1. **`requeueStuck()`** — revisions stuck `running` longer than
   `STALE_INDEXING_TIMEOUT_MIN` (default 15) go back on the queue. This is the
   crashed-mid-pipeline case.
2. **`retryFailed()`** — `failed` jobs with `attempts` below `STALE_MAX_ATTEMPTS`
   (default 5), and older than a two-minute cooldown so a fast-failing job is not
   hammered.
3. **`reindexDrifted()`** — branch heads whose `document_revisions.embedding_model`
   is null or no longer equals the current signature.

Drift detection is the interesting one. `embeddingSignature(config)` builds
`provider:model:dim:recipe` — four segments, e.g. `stub:default:384:r2` on a
default deployment — and it is stamped onto the revision at index time. Because
the recipe is in the signature, changing _how_ text is assembled for embedding
invalidates the corpus just as surely as changing the model does, and the sweeper
notices either way.

Retries mint a **fresh BullMQ job id**: `IngestionProducer.enqueueRetry(id,
salt)` produces `` `${ingestionJobId}#${salt}` `` with the job's `attempts` as
the salt. This is not cosmetic — BullMQ dedupes by job id and the queue is
configured `removeOnFail: false`, so the kept failed job blocks reuse of the
original id and a plain re-enqueue would silently do nothing.
`reindexDrifted()` uses plain `enqueue` instead, because it creates new job
rows with ids of their own.

## Data model

| Table                | Notes                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestion_jobs`     | The outbox. Created in the finalize transaction; its `id` is the BullMQ `jobId`. `payload.reason = 'dependent-reindex'` marks a cascade job so it never cascades. |
| `document_revisions` | `embedding_model` holds the four-segment signature stamped at index time; `indexed_at` is set in the same transaction that completes the job.                     |

Chunks, vectors and relation edges live in ArcadeDB, reached only through
`GraphService` — see [04](04-search-graph.md).

## Routes

| Route                       | Access                      | Notes                            |
| --------------------------- | --------------------------- | -------------------------------- |
| `GET /v1/ingestion/jobs/:id`  | `@Access('viewer', 'job')`  | `:id` through `ParseUUIDPipe`    |
| `GET /v1/ingestion/stale`     | `@Access('admin', 'query')` | requires `?workspaceId=`         |
| `POST /v1/ingestion/reindex`  | `@Access('admin', 'body')`  | `@HttpCode(202)`                 |

MCP exposes `knowledge_ingest({ workspaceId, documentId? })`, a thin delegation
to the same `IngestionAdminService.reindex` that backs the REST route — forcing
a reindex of one document's branch heads, or of every branch head in the
workspace.

## Modules

| Module                  | Contents                                              | Loaded by                      |
| ----------------------- | ----------------------------------------------------- | ------------------------------ |
| `IngestionModule`       | Producer only (`IngestionProducer`, queue registration) | API and worker                 |
| `IngestionWorkerModule` | `IngestionProcessor`, `OutboxSweeper`, `StaleSweeper`   | the worker entrypoint **only** |
| `IngestionAdminModule`  | `IngestionController`, `IngestionAdminService`          | `AppModule` and `McpModule`    |

`IngestionWorkerModule` must never be imported into `AppModule` — the API
process would start consuming jobs. This is verifiable rather than a convention:
it appears only in `worker.module.ts`.

`IngestionAdminModule` is imported by the MCP entrypoint as well as the API,
because that is how `knowledge_ingest` reaches `IngestionAdminService`; the
controller comes along with it.

## Where this diverges from plan.md

- **Diffs are not computed during ingestion.** `plan.md` §5's pipeline ends
  "compute diff & semantic diff vs. parent revision → mark revision INDEXED".
  The implementation does not: diffs are computed on demand by `CompareService`
  and cached in `revision_diffs` ([02](02-persistence-revisions.md)). Ingestion
  never touches them.
- **The four fact classes are spelled differently.** `plan.md` §5 names them
  explicit / deterministic / inferred / curated; the `extractor` union is
  `'explicit' | 'frontmatter' | 'inferred' | 'curated'`. `frontmatter` _is_ the
  deterministic class — it is simply the only deterministic extractor built, so
  the value names the source rather than the category. The OpenAPI/Prisma-schema
  parsers §5 also lists as deterministic do not exist.
- **No `manifest.json`.** `plan.md` §4's object layout lists `manifest.json`,
  `extracted.txt`, `graph-projection.json` and `diff-from-parent.json` beside
  the source; none of the four has a writer anywhere in `apps/api/src`. The
  `embeddingModel` field §4 puts in the manifest lives on
  `document_revisions.embedding_model` instead.
- **The ingestion route surface differs.** `plan.md` §7 declares
  `POST /v1/ingestion/jobs`; the implemented admin surface is
  `POST /v1/ingestion/reindex` (202) plus `GET /v1/ingestion/stale`, with
  `GET /v1/ingestion/jobs/:id` the only route the two agree on.
- **Stale detection is signature drift, not topology drift.** `plan.md` §11's
  Phase 5 asks for "topology drift vs. documentation"; what is implemented
  compares the embedding signature and job state. Nothing compares a documented
  topology against a real one.
- **MCP names use underscores.** `knowledge.ingest` in `plan.md` §9 is
  `knowledge_ingest` in the server — MCP tool names forbid dots. The mapping is
  1:1 otherwise.

## Limits

Markdown only. Step 2 rejects anything that is not markdown or `text/*`, so the
pipeline has no parser branch for other content types — importing a PDF or a
`.docx` is a separate flow that produces markdown _before_ a revision exists.

Chunk sizing (3200 / 400), the embed batch stride (32) and the sweep caps (10
per job, per pass) are all inline literals. They are not tunable without a
deploy, which is fine while they are right and invisible when they are not.

The sweeper's three jobs share one 5-minute tick, so a workspace with many stuck
jobs drains at 10 per job per 5 minutes regardless of how idle the worker is.

`OutboxSweeper` and `StaleSweeper` both assume a single worker is enough; neither
coordinates across worker instances beyond BullMQ's own job-id dedupe.
