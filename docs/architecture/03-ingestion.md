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

The other queues that commit a row before enqueueing its job have the same
relay (#657), each in a worker-side sweeper beside its processor and each
re-enqueueing under the jobId of the row's last enqueue, so a job that is merely
waiting absorbs it:

| Row                         | Stale after                           | Relayed by                                         |
| --------------------------- | ------------------------------------- | -------------------------------------------------- |
| `agent_runs` `pending`      | 10 min since `updatedAt`              | `AgentScheduleSweeper.relayPending` (`id`, or `id:attempt`) |
| `agent_runs` `running`      | 30 min since the last heartbeat       | `AgentScheduleSweeper.requeueStuck` (retry)        |
| `connector_runs` `queued`   | 15 min since `startedAt` / `createdAt` | `ConnectorScheduleSweeper.relayQueued` (`id`, or `id#relay` for a continuation) |
| `import_jobs` `queued`      | 10 min since `createdAt`              | `ImportRelaySweeper`                               |
| `memos` `uploaded` / `transcribed` | 10 min since `updatedAt`       | `MemoRetentionSweeper`                             |

The relay halves run whatever `AGENT_SCHEDULE_ENABLED` and
`CONNECTOR_SCHEDULE_ENABLED` say; those flags gate only the starting of
scheduled runs. A duplicate that slips through still loses its processor's
guarded claim.

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
| 2     | Parse with gray-matter (`matter(raw)`); non-markdown/non-`text/*` is rejected. A spec document parses by its kind instead (below) | —       |
| 3     | Normalize via `splitMarkdown`, persist `normalized.json` beside the source | `normalize` |
| 3b    | Embed groups — record `revision_embeds`, queue snapshot renders (#470)   | `embeds`     |
| 3c    | Page links — replace `page_links` for a default-branch head (#673)       | `links`      |
| 4     | Chunk — `chunkSections(sections)`, then one chunk per embedded frame     | `chunk`      |
| 5     | Embed — title + heading breadcrumb + body, in slices of 32               | `embed`      |
| 6     | Index into the graph store — `graph.upsertRevisionChunks`                | `graph`      |
| 6b    | Optional BM25 mirror — `fulltext.indexRevisionChunks`, non-fatal         | `fulltext`   |
| 7     | Deterministic relations — frontmatter facts                              | `relations`  |
| 7a    | Spec facts — `DESCRIBES` per operation, specs only                       | `spec`       |
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
recreating them, so running it twice converges rather than duplicating. Chunks
carry no system time, so recreating them loses nothing. Relation edges are
different; see the next paragraphs.

**Links between pages** (#673). Step 3c runs only when the revision is the
default-branch head (`live`). `pageLinkTargets` (`ingestion/page-links.ts`)
reads the body's link tokens through `markdownLinks` — the editor's own marked
instance, so code spans, fences and images are never links — and keeps those
that resolve to `/documents/<uuid>` on `WEB_BASE_URL`'s origin, with the decoded
`#fragment` as the anchor, one row per (target, anchor), self-links dropped.
`replacePageLinks` swaps the page's rows inside a transaction that first
share-locks the default branch row and re-checks that the revision is still its
head: a finalize moving the head waits on the lock, so an older revision's job
that finishes late writes nothing instead of restoring stale links. The table
holds only current links; there is no per-revision history, and a branch
revision links nothing until it merges. Reads are `GET /v1/documents/:id/backlinks`
and MCP `knowledge_get_document`'s `backlinks`, both through
`DocumentsService.getBacklinks`, which filters sources by `visibilityWhere`,
`LISTED_PAGE` and `archivedAt: null`. Pages indexed before the table existed are
filled once by `make page-links-backfill`. Nothing reaches the graph: links are
not edges, and nothing re-embeds.

**Embedded designs** (#470, [feature 64](../features/64-embeds.md)). Step 3b
reads the page's embed groups with `embedGroupsOf` (no DOM) and rewrites the
revision's `revision_embeds` rows, one per item, each with a `warning` for what
the markdown got wrong (`unknown-provider`, `unpinned`, `over-limit`). It then
queues one render per pinned item on the `embeds` queue; the job id is the item,
so every page pinning the same node at the same version shares one render. It
runs before the embedder so a page's snapshots never wait on a model, and it
never calls Figma. Step 4 appends, after the page's own chunks, one chunk per
pinned item whose file still passes the allowlist and whose cache row has a name
or text: `Figma frame "<name>" in "<file>"`, the caption, the text layers, under
heading path `Figma > <file>`. The render job (`EmbedSnapshotService`, worker
only) resolves the file through the Figma connector's allowlist, writes the PNG
and the `embed_nodes` cache row, and, when it stored a name or text, reindexes
the default-branch heads that pin the item through this same outbox (`reason:
'embed rendered'`). A rendered item returns early from the job, so that reindex
cannot loop.

**Valid time is stamped after every job** (#81). `stampValidity` reads the
page's finalized revisions from PG (`loadRevisionStamps`) and rewrites the
`validFrom`/`validTo`/`lineage` of the indexed revision and its default-branch
neighbours, on chunks and revision-scoped edges, then the same on the BM25
mirror (non-fatal). Because the interval is a pure function of PG order, jobs
finishing out of order converge. Once a page's new head is live, its open
conflicts quoting an older revision are superseded.

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
is `'explicit' | 'frontmatter' | 'inferred' | 'curated' | 'code' | 'spec'`
(`FactExtractor`); `spec` is described under [Spec documents](#spec-documents).

A linked API block (`data-kn-op` on its wrapper) is read by
`readApiOperationRefs` (`common/relations.ts`) as an `IMPLEMENTS` fact in the
frontmatter class: it is the author's declaration in the page source, so it is
replaced per revision like `relations:`. Only `op:` / `channel:` keys count.

The fifth class is not read from a page. A `component:` block
([feature 51](../features/51-component-pages.md)) is recorded by the processor
into `component_declarations` (`ComponentsService.record`), and the `code` edges
are derived from it and the connector's import index by
`ComponentsService.rebuild`, which runs after every codebase pull and after a
declaration changes. The same rebuild stores each declaration's
`missing_paths` against the head's `code_files`. A frontmatter relation cannot
claim the `code` extractor.

Reindexing reconciles only that revision's frontmatter edges, and since #81 it
never deletes. `reconcileRevisionFacts` reads the revision's rows for one
extractor (scoped by revision _and_ extractor, so explicit, curated and
inferred edges are untouched) and diffs them by `(type, targetKey)`:
re-asserted facts are updated in place, new ones created, and dropped ones
**expired** (`expiredAt`, `retractedBy: 'extractor'`, `live = false`). The
inferred and spec extractors go through the same path.

**Explicit relations** come from a person or an API client, not from the
document body: `relations[]` on `POST /v1/documents`
(`@Access('editor', 'body')`) or `POST /v1/documents/:id/relations`
(`@Access('editor', 'document')`), both landing in
`DocumentsService.toFacts` with `extractor: 'explicit'` and confidence 1.
Re-posting replaces by `(documentId, targetKey, type)`: the previous edge is
**retracted** (`expiredAt`, `validTo`, `retractedBy: user:<id>`), not deleted
(#81). So are an edge removed through `DELETE …/relations` and one curation
replaces.

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

## Spec documents

An OpenAPI or AsyncAPI spec ([feature 52](../features/52-api-reference.md)) is
a document whose `kind` is `openapi` or `asyncapi`, and it goes through the
same job. **The processor branches on `document.kind`, never on the content
type**: a `text/yaml` body would pass the step 2 content-type check and then be
read as prose. `isApiSpecKind(kind)` sends step 2 to
`ApiSpecsService.project`, which:

1. Parses with `parseApiSpec` (`api-specs/api-spec.parser.ts`):
   `@scalar/openapi-parser` for OpenAPI 2.0 / 3.0 / 3.1, upgraded to 3.1 with
   internal `$ref`s dereferenced, and an in-house reader on js-yaml for
   AsyncAPI 2.x / 3.x. No fetch plugin is passed, so a remote `$ref` is a
   validation error and never a request. `API_SPEC_MAX_BYTES` and
   `API_SPEC_MAX_OPERATIONS` cap the input. A spec that will not parse fails
   the job with the validator's messages. Finalize would already have refused
   it, unless a limit was lowered since.
2. Resolves the slug. `documents.spec_slug` is pinned at the first indexed
   revision with a guarded `updateMany(… specSlug: null)`. Only an
   `x-knowledge-key` on the default-branch head re-pins it, so a title edit
   cannot fork every operation entity.
3. Replaces the revision's `api_operations` rows (`deleteMany` then
   `createMany` on `revisionId`), which makes a reindex converge like
   `upsertRevisionChunks`.
4. Renders the **markdown projection** (`renderSpecProjection`): one `##` per
   tag, one `###` per operation, parameters, body and responses as GFM tables,
   with a cycle-safe schema walk.

The projection becomes `parsed.content`, with empty frontmatter, and steps 3–8
run unchanged. That is why search, BM25 and the assistant read a spec with no
code of their own. `normalized.json` gains a `spec` block (kind, version,
title, slug, operation count). The source object is `source.yaml` /
`source.json` under an `application/vnd.oai.openapi+…` or
`application/vnd.aai.asyncapi+…` content type, named by
`StorageService.sourceObjectName(contentType)`; existing rows keep their
stored `s3Key`.

Step 7a writes `document -DESCRIBES-> op:<slug>:<METHOD> <path>` (or
`channel:<slug>:<address>`) per operation through
`GraphService.replaceRevisionSpecFacts`, with **`extractor: 'spec'`**. It is
not `explicit`, because explicit edges are document-level and always live, so a
branch revision of a spec would publish its operations before the merge. `spec`
is in `REVISION_SCOPED_EXTRACTORS` with `frontmatter` and `inferred`, so it
follows the live projection, and the frontmatter replace never touches it. A
page never has spec edges to clear, because a kind never changes.

Path parameters fold to `{}` inside `normalizeEntityKey`, for `op:` and
`channel:` keys only. Every writer calls it, so a page's frontmatter naming
`/users/{userId}` lands on the vertex the spec wrote for `/users/{id}`.

`ApiSpecsCoreModule` (parse, project, read, diff; controller-free) is imported
by the worker and the API. `ApiSpecsModule` carries the controllers and the
try-it proxy and never loads in the worker.

### Test fixtures (#483)

A `test-fixture` document is YAML or JSON too, and `isTestFixtureKind(kind)`
sends step 2 to `ApiFixturesService.project` rather than to the spec branch.
`isApiSpecKind` is false for it; `isStructuredKind` (spec **or** fixture) is
what decides "verbatim body, no frontmatter, `vnd` content type"
(`application/vnd.knowledge.test-fixture+yaml|json`). `project`:

1. Reads the body with `readTestFixture` (`@knowledge/contracts/api/fixtures`),
   the shape check finalize already ran. Finalize also checked, **as the
   revision's author** (`PermissionService.scopeForUser`), that every call
   names an operation at a spec head they can open and that no Authorization,
   Cookie or API-key slot holds a literal. The worker does not re-check either.
2. Replaces the revision's `api_fixture_calls` rows (one per call step, with
   its phase and position), which the library and knowledge health read in SQL.
3. Renders a projection: one `###` per step with its operation, expected status
   and captures, and the request in a fenced block with placeholders as written.

Step 7a writes `fixture -DEPENDS_ON-> op:…` per distinct called operation,
in the same `spec` class, so impact analysis on an operation lists the
fixtures that call it. A fixture whose head calls an operation no spec head
defines any more is `broken-calls` in knowledge health (`brokenCallsSql`):
derived on read, never stored.

## Stale detection and reindex

`StaleSweeper` (`apps/api/src/ingestion/stale.sweeper.ts`) is registered only in
`IngestionWorkerModule`, so it runs in the worker and nowhere else. It ticks
every 5 minutes (`setInterval(…, 5 * 60_000)` — an inline literal, there is no
interval constant or env var), is gated by `STALE_SWEEP_ENABLED`, calls
`.unref()` so it never holds the process open, and guards re-entrancy with a
`running` flag. Each pass does four unrelated jobs, the first three capped at
10 rows:

1. **`requeueStuck()`** — revisions stuck `running` longer than
   `STALE_INDEXING_TIMEOUT_MIN` (default 15) go back on the queue. This is the
   crashed-mid-pipeline case.
2. **`retryFailed()`** — `failed` jobs with `attempts` below `STALE_MAX_ATTEMPTS`
   (default 5), and older than a two-minute cooldown so a fast-failing job is not
   hammered.
3. **`reindexDrifted()`** — branch heads whose `document_revisions.embedding_model`
   is null or no longer equals the current signature.
4. **`repairFulltext()`** — `indexed` revisions with `fulltext_stale_at` set, 25
   a pass, only when a BM25 provider is configured (#173). The processor stamps
   that column when step 6b or the fulltext half of the live flip fails, and
   clears it when a later 6b succeeds. The repair reads the revision's chunks
   back from the graph (`GraphService.getRevisionChunkTexts`), so nothing is
   re-chunked or re-embedded and the chunk ids stay the ones the vector store
   has. It mirrors them into the BM25 index, makes them live there if the
   revision is the default-branch head, and clears the stamp with
   `updateMany({ where: { id, fulltextStaleAt: <the value it read> } })`, so a
   failure recorded meanwhile keeps the revision due. The first failure ends
   the pass, since an index that is still down would fail every row.

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

## Audio: memos (#551)

A second write path that starts from bytes, not markdown, and ends in merge requests, never in an indexed
revision. A memo's transcript is never chunked, embedded or searched. The full record is
[doc 68](../features/68-memos.md); what belongs here is how it sits beside ingestion:

- **Same upload shape.** Reserve (`POST /v1/memos`), presigned PUT straight to MinIO, then finalize. The
  size is re-read from the bucket. The API never streams the bytes, and the audio sits under
  `workspaces/{ws}/memos/{id}/`.
- **Its own queue.** `memo` (`MemosQueueModule`, producer in both processes). jobId = memo id, removed on
  either outcome so Retry can queue it again. `MemosProcessor` lives in `MemosWorkerModule`, imported only
  by `worker.module.ts`, beside `MemoRetentionSweeper`.
- **The only shell-out in the worker.** `ffprobe` / `ffmpeg` (in the `api` image) normalise to 16 kHz mono
  mp3 in 10-minute chunks. Each chunk goes to the operator's OpenAI-compatible `/audio/transcriptions`
  endpoint over a plain `fetch`, with env as the only source of the URL. The stitched segments are masked
  by one `createMasker()` before the single write.
- **Then an agent run, then the API.** The processor creates the `secretary` run itself, and
  `MemoPublishSweeper` (API-only) opens its proposals as merge requests: the house "worker generates, API
  publishes" split, with the sweeper doubling as recovery.

## Data model

| Table                | Notes                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestion_jobs`     | The outbox. Created in the finalize transaction; its `id` is the BullMQ `jobId`. `payload.reason = 'dependent-reindex'` marks a cascade job so it never cascades. |
| `document_revisions` | `embedding_model` holds the four-segment signature stamped at index time; `indexed_at` is set in the same transaction that completes the job.                     |
| `code_imports`, `code_files` | A codebase connector's head: importer → imported file with the names taken, and every file. Replaced whole per pull, in one transaction (feature 51).        |
| `component_declarations` | One row per page with a `component:` block: resolved connector, paths, symbols, warning, `missing_paths`. Written by ingestion, re-resolved per pull.       |
| `documents.kind`, `documents.spec_slug` | `page` \| `openapi` \| `asyncapi`, default `page`. The slug is pinned at a spec's first indexed revision (feature 52). |
| `page_links` | One row per (target page, anchor) on each page's default-branch head (#673). Replaced whenever a head indexes; no FK on either page, the source's rows deleted by the project cascade. |
| `revision_embeds` | One row per embed item per revision (#470): group, position, URL, file/node/version, caption, `warning`. Rewritten per revision; no FK, deleted by the project cascade. |
| `embed_nodes`, `embed_files`, `embed_node_heads` | The snapshot cache (immutable per pinned version), the allowlist's files as last listed, and each pinned node's current hash from the change check (feature 64). |
| `api_operations` | One row per operation or channel per revision: protocol, method, path, `entity_key`, summary, tags, `pointer`. A projection, replaced per revision; unique on `(revision_id, entity_key, method)`, because an AsyncAPI channel carries both a send and a receive. |

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
| `EmbedsCoreModule`      | `EmbedsService`, the `embeds` queue (#470)              | API, worker, MCP, public       |
| `EmbedsWorkerModule`    | `EmbedSnapshotService`, `EmbedsProcessor`, `EmbedChangeSweeper` | the worker entrypoint **only** |
| `MemosCoreModule`       | `MemosService`, imports `MemosQueueModule` (#551)        | API, MCP                       |
| `MemosModule`           | `MemosController`, `MemoPublishSweeper`                 | `AppModule` only               |
| `MemosWorkerModule`     | `MemosProcessor`, `TranscriptionClient`, `MemoRetentionSweeper` | the worker entrypoint **only** |

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
  deterministic class; the value names the source rather than the category.
  Of the parsers §5 also lists as deterministic, the OpenAPI one now exists
  (and reads AsyncAPI too) under its own value, `spec`. The Prisma-schema
  parser does not exist.
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

Markdown, or a spec. Step 2 rejects a page body that is not markdown or
`text/*`, and the only other parser branch is the spec kind, which still ends
in markdown (the projection). Importing a PDF or a `.docx` is a separate flow
that produces markdown _before_ a revision exists.

Chunk sizing (3200 / 400), the embed batch stride (32) and the sweep caps (10
per job, per pass) are all inline literals. They are not tunable without a
deploy, which is fine while they are right and invisible when they are not.

The sweeper's four jobs share one 5-minute tick, so a workspace with many stuck
jobs drains at 10 per job per 5 minutes regardless of how idle the worker is.

`OutboxSweeper` and `StaleSweeper` both assume a single worker is enough; neither
coordinates across worker instances beyond BullMQ's own job-id dedupe.
