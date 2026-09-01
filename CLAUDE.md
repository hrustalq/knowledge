# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dynamic Knowledge Platform — a graph + semantic documentation store with REST API, GitLab-style revision DAG, and (eventually) an MCP interface for agents. `plan.md` is the authoritative architecture document; the approved Phase 0/1 implementation plan lives at `~/.claude/plans/indexed-sleeping-moler.md`. Phases 0–4 are implemented (revision DAG + branches, compare endpoints, deterministic frontmatter relations, MCP server, merge requests with structural/semantic diff and If-Match concurrency, LLM relation extraction, hybrid search graph expansion, entity traversal + curation). Phase 5 (real auth/ACLs, audit logging, OpenSearch, stale-doc detection) is deliberately stubbed.

## Commands

The root `Makefile` is the entry point — run `make help` for the full list.

```bash
make setup              # first-time: env files → pnpm install → infra → migrations → build
make dev                # infra containers + api :3000 (Swagger /docs) + web :5173 + ingestion worker, watch mode (turbo)
make kill               # kill this repo's dev processes (api, web, worker, mcp, turbo); kill-all also stops infra
make dev-worker         # run only the BullMQ ingestion worker (already included in make dev)
make dev-mcp            # MCP server on stdio (knowledge_* tools) — for agent clients
make check              # lint + typecheck + build (CI gate)
make smoke              # health-check all six services

make infra-up|down|logs # docker compose: postgres, minio (+bucket init), redis, arcadedb
make db-migrate-new name=<x>   # create + apply a named Prisma migration
make db-migrate-deploy  # apply committed migrations only (prod-style)
make db-reset           # DESTRUCTIVE: drop DB, replay migrations
make env-check          # compare .env files against .env.example
```

Per-workspace: `pnpm --filter @knowledge/api run dev`, `pnpm --filter @knowledge/web run typecheck`, etc. There is no test suite yet — verification is the e2e flow (upload → finalize → poll `indexed` → search) plus `make check`.

## Architecture

Three-store separation (never mix responsibilities):

- **PostgreSQL** (Prisma, `apps/api/prisma/schema.prisma`) — transactional truth: documents, branches, immutable revisions + `revision_parents` DAG, `ingestion_jobs` (outbox), `revision_diffs` (table exists, endpoints are Phase 2).
- **MinIO** (versioned bucket `knowledge`) — raw bytes. Keys: `workspaces/{ws}/documents/{doc}/revisions/{rev}/source.md` + `normalized.json`. Clients upload directly via presigned PUT; the API never streams file bodies.
- **ArcadeDB** — graph + vectors (Document/DocumentRevision/Chunk vertices, HAS_REVISION/HAS_CHUNK edges). No official JS driver: `ArcadeClient` (apps/api/src/graph/arcade.client.ts) speaks plain HTTP (`POST /api/v1/command|query/knowledge`, Basic auth). **All graph queries must go through `GraphService`** — it is the single injection point for the mandatory workspace predicate (plan.md §6 security note). Phase 1 vector search is cosine-in-Node inside `GraphService.searchChunks`; swapping to native HNSW later should touch only that method.

Write path: `POST /v1/documents` → `POST :id/uploads` (presigned PUT) → `POST .../finalize` (SHA-256 hash, dedupe, revision → `finalized`, `ingestion_jobs` row committed in the same transaction = outbox) → BullMQ job → worker pipeline (fetch → gray-matter parse → heading-aware chunking in `src/ingestion/markdown.ts` → embed → upsert graph) → revision `indexed`. Status lifecycle: `draft → finalized → indexing → indexed | failed`. `OutboxSweeper` re-enqueues stale `queued` jobs; BullMQ `jobId` = `ingestion_jobs.id` makes double-enqueues harmless.

Key structural decisions:

- **The worker is a second entrypoint of `apps/api`**, not a separate app: `src/main.ts` (HTTP) vs `src/worker.main.ts` (`createApplicationContext(WorkerModule)`, no HTTP). `IngestionModule` (producer) is imported by both; `IngestionWorkerModule` (processor + sweeper) only by the worker — don't import it into `AppModule` or the API process will start consuming jobs.
- **`packages/contracts`** is a buildless TS package (`"exports": "./src/index.ts"`) holding plain request/response types shared by api and web. Keep it free of Prisma/server imports. Types are named to map 1:1 onto future MCP tools (`knowledge.search` → `SearchService`).
- **Embeddings** are pluggable behind the `EMBEDDING_PROVIDER` token: `stub` (deterministic hash vectors, default — full e2e with zero external deps) or `openai-compatible` (`EMBEDDINGS_BASE_URL` must include `/v1`; covers OpenAI/Ollama/LM Studio/vLLM). Configured via env, validated by zod in `src/config/env.ts` (fail-fast on boot).
- **Phase 2 revision DAG & compare**: `document_revisions.branch_id` ties every revision to its branch; `finalizeRevision` advances *that* branch's head (falls back to the default branch for legacy rows). `POST /:id/branches` forks from a finalized revision (default: default-branch head); `GET /:id/revisions` returns the DAG (`parentRevisionIds` from `revision_parents`). `GET /:id/compare?from&to&mode=direct|merge-base` lives in `CompareService`: merge-base = BFS nearest-common-ancestor over the parent map, line diff via the `diff` package (`structuredPatch`), results cached in `revision_diffs` (immutable revisions → cache never invalidates; only finalized revisions are comparable).
- **Deterministic relations** (plan.md §5 fact classes): the worker's step 7 parses frontmatter `relations:`/`tags:` (`src/ingestion/relations.ts`) into typed edges with provenance (`extractor: 'frontmatter'`, confidence 1); reindexing deletes+recreates only that revision's frontmatter edges. Explicit relations come from `POST /v1/documents` `relations[]` or `POST /:id/relations` (`extractor: 'explicit'`, re-posting replaces by `(documentId, targetKey, type)`). Edge type names are SQL-interpolated, so everything is validated against `RELATION_EDGE_TYPES` in `GraphService` — never widen that list without keeping the allowlist check.
- **Phase 3 merge requests** (`MergeRequestsService`): `POST /:id/merge-requests`, `GET/approve/merge/close /v1/merge-requests/:id`. Merging is **fast-forward-preconditioned** — the target head must equal the merge base, otherwise 409 with a comparison link (3-way content merge is future work). `merge-commit` creates a two-parent DAG node (`revision_parents` order 1 = target head, 2 = source head), `squash` a single-parent one; both copy the source head's bytes and run the normal finalize → outbox → reindex pipeline. Compare gained `?structural=` (path-level diff of JSON/YAML bodies or markdown frontmatter, `src/documents/structural-diff.ts`, cached in `revision_diffs` as `structural-json`) and `?semantic=` (graph-projection diff: per-revision frontmatter relation edges + `GraphService.revisionEmbeddingShift`). Optimistic concurrency: `If-Match: <expected-head-revision-id>` on `POST /:id/revisions` → 409 + `comparisonUrl` when the branch head advanced (MCP equivalent: `baseRevisionId`).
- **Phase 4 inference & traversal**: LLM relation extraction is pluggable behind the `RELATION_EXTRACTOR` token (`src/extraction/`), mirroring embeddings: `none` (default — worker still runs the step to clear stale inferred edges) or `openai-compatible` (`EXTRACTOR_BASE_URL` with `/v1`, chat completions, JSON output). Inferred edges carry `extractor: 'inferred'`, clamped confidence (≥ `EXTRACTOR_MIN_CONFIDENCE`), `sourceChunkId` + `snippet`; extraction failures are non-fatal (revision stays `indexed`). Fact-class protection lives in `GraphService.replaceRevisionInferredFacts`: re-extraction deletes only that revision's inferred edges and skips any (type, target) already covered by a curated or explicit edge. Curation: `POST /:id/relations/curate` (confidence 1, replaces inferred/curated dups), `DELETE /:id/relations?type&targetKey&extractor`. Traversal (`src/entities/`): the graph is bipartite (edges always Document → Entity, `doc:<id>` node convention); BFS happens in Node over `GraphService.getWorkspaceRelationGraph` via pure helpers in `src/graph/graph-walk.ts` — one entity hop = two BFS hops. `GET /v1/entities`, `GET /v1/entities/trace` (declared before `:key` routes!), `GET /v1/entities/:key/neighbors`, `POST /v1/entities/:key/impact-analysis` (dependents = docs referencing the entity, then entities those docs DESCRIBE; dependencies = the reverse). Hybrid search: `expandGraph: { depth, relationTypes }` on `POST /v1/search` attaches `entities` to each hit and returns `related[]` docs reachable only through the graph, with connecting edges as evidence. MCP gained `knowledge_find_relations`, `knowledge_impact_analysis`, `knowledge_trace_relation`.
- **MCP server is a third entrypoint** (`src/mcp.main.ts`, `make dev-mcp`): stdio transport, Nest logging disabled (stdout belongs to JSON-RPC; `abortOnError: false` so boot errors reach stderr). Tools are named with underscores (`knowledge_search`, `knowledge_compare_revisions`, …) because MCP tool names forbid dots, but map 1:1 onto plan.md §9's dotted names. Any service injected into `McpService` must be *exported* by its module (SearchModule exports SearchService for exactly this).
- **Frontend SSR** (apps/web): create-vite-extra skeleton — `server.js` runs Vite middleware in dev / sirv in prod and splices `render(url)` output into `<!--app-head-->`/`<!--app-html-->`. Fresh app/router/pinia per request (`src/main.ts` factory); Pinia state is serialized to `window.__PINIA__` for hydration. API base URL: SSR uses `API_URL_INTERNAL` directly; the browser goes through the Vite `/api` proxy (no CORS).

## Gotchas

- `apps/api` is **ESM** (`"type": "module"`, NodeNext): relative imports require the `.js` suffix (`./app.module.js`), including for `.ts` sources.
- class-validator `@IsUUID()` rejects nil-style UUIDs (version digit must be 1–5). The demo workspace is `11111111-1111-4111-8111-111111111111` (`DEMO_WORKSPACE_ID` in `apps/web/src/lib/api.ts`); auth is a hardcoded stub until Phase 5.
- Content dedupe is **per-branch** (`@@unique([documentId, branchId, contentHash])`) — a merge revision legitimately repeats the source head's content on the target branch, so dedupe must not span branches (and never spans documents). `content_hash`/`s3_version_id` are nullable until finalize.
- `pnpm dlx` can hang on interactive prompts in non-TTY runs — `shadcn-vue` is a devDep; use `pnpm exec shadcn-vue add <component>` from `apps/web`.
- `corepack` doesn't exist on this Node install; pnpm is pinned only via the `packageManager` field.
- Reindexing is idempotent by design: `GraphService.upsertRevisionChunks` deletes the revision's chunks/vertex before recreating them, and the processor skips jobs already `completed`.
