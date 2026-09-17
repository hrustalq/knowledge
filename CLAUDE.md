# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dynamic Knowledge Platform — a graph + semantic documentation store with a REST API, a GitLab-style revision DAG, and an MCP interface for agents. Phases 0–5 and product features 01–27 are implemented.

**This file carries code-level conventions and gotchas only.** The narrative of how any one area works lives elsewhere:

| Document                                       | Answers                                                        |
| ---------------------------------------------- | -------------------------------------------------------------- |
| [`plan.md`](plan.md)                           | What we set out to build — design intent, phased plan           |
| [`docs/architecture/`](docs/architecture/README.md) | How it is actually built, one doc per logic layer          |
| [`docs/features/`](docs/README.md)             | The product layer, one doc per feature (01–27)                  |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)           | Process: branches, commits, release, rollback                   |
| [`docs/versioning.md`](docs/versioning.md)     | What the version number promises                                |

Where the code has diverged from `plan.md`, the architecture docs say so. `plan.md` is not retro-edited to match the code.

## Commands

The root `Makefile` is the entry point — run `make help` for the full list.

```bash
make setup              # first-time: env files → pnpm install → infra → migrations → build
make dev                # infra + api :3000 (Swagger /docs) + web :5173 + ingestion worker (turbo watch)
make kill               # kill this repo's dev processes; kill-all also stops infra
make dev-worker         # only the BullMQ ingestion worker (already part of `make dev`)
make dev-mcp            # MCP server on stdio (knowledge_* tools) — for agent clients

make verify             # PRE-PUSH GATE: db-generate + lint + typecheck + deps + test (no build)
make check              # CI gate: lint + typecheck + deps + test + build
make deps               # dependency-cruiser: process boundaries, layering, cycles, buildless rules
make deps-baseline      # re-record known violations (shrink-only: drops fixed ones, never adds)
make smoke              # health-check every service
make backtest           # retrieval/pipeline backtest. ARGS="--generate --limit 120" | "--report"

make infra-up|down|logs        # docker compose: postgres, minio (+bucket init), redis, arcadedb
make infra-up-opensearch       # + optional OpenSearch BM25 node (FULLTEXT_PROVIDER=opensearch)
make infra-up-searxng          # + optional SearXNG node (WEB_SEARCH_URL + WEB_ACCESS_MODE)
make db-migrate-new name=<x>   # create + apply a named Prisma migration
make db-migrate-deploy         # apply committed migrations only (prod-style)
make db-reset                  # DESTRUCTIVE: drop DB, replay migrations
make env-check                 # compare .env files against .env.example
make auth-bootstrap email=<e>  # create user + API key + workspace membership (AUTH_MODE=api-key)

make api-schema         # emit apps/api/openapi.json from the Nest app (no server/infra; env file required)
make api-client         # api-schema + docs-reference + openapi-typescript → apps/web/src/api/schema.d.ts
```

**Use `make verify`, not `make check`, while a dev server is running.** `check` rebuilds `apps/api/dist` under the running `nest start --watch` and takes :3000 and :5173 down with it. `verify` is everything in `check` except `build`, and is what `.husky/pre-push` runs.

Per-workspace: `pnpm --filter @knowledge/api run dev`, `pnpm --filter @knowledge/web run typecheck`. Verification is `make verify` plus the e2e flow (upload → finalize → poll `indexed` → search).

## Architecture

Containment is three levels deep: **Workspace > Project > Document**. The workspace is the tenant/ACL boundary; the project is organizational only.

Three-store separation (never mix responsibilities):

- **PostgreSQL** (Prisma, `apps/api/prisma/schema.prisma`) — transactional truth: documents, branches, immutable revisions + the `revision_parents` DAG, `ingestion_jobs` (outbox), `revision_diffs`.
- **MinIO** (versioned bucket `knowledge`) — raw bytes. Keys: `workspaces/{ws}/documents/{doc}/revisions/{rev}/source.md` + `normalized.json`. Clients upload directly via presigned PUT; **the API never streams file bodies**.
- **ArcadeDB** — graph + vectors. No official JS driver: `ArcadeClient` (`apps/api/src/graph/arcade.client.ts`) speaks plain HTTP. **All graph queries must go through `GraphService`** — it is the single injection point for the mandatory workspace predicate ([plan.md §6](plan.md) security note).

Write path: `POST /v1/documents` → `POST :id/uploads` (presigned PUT) → `POST .../finalize` (SHA-256 hash, dedupe, revision → `finalized`, `ingestion_jobs` row committed in the same transaction = outbox) → BullMQ job → worker pipeline → revision `indexed`. Status lifecycle: `draft → finalized → indexing → indexed | failed`.

**The worker is a second entrypoint of `apps/api`, not a separate app** — `src/main.ts` (HTTP) vs `src/worker.main.ts` (`createApplicationContext(WorkerModule)`, no HTTP), alongside `src/mcp.main.ts` (third) and `src/scripts/generate-openapi.main.ts` (fourth). `IngestionModule` (producer) is imported by both; **`IngestionWorkerModule` only by the worker** — import it into `AppModule` and the API process starts consuming jobs.

See [`docs/architecture/01-entrypoints-modules.md`](docs/architecture/01-entrypoints-modules.md) for the module-split rules the dependency-cruiser configs enforce.

## Where each area is documented

**Layers** — [`docs/architecture/`](docs/architecture/README.md):

| Doc                                                                     | Covers                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [01 entrypoints & modules](docs/architecture/01-entrypoints-modules.md)  | Four entrypoints, Core/Queue/API/Worker split, buildless packages   |
| [02 persistence & revisions](docs/architecture/02-persistence-revisions.md) | Branches, revision DAG, compare, diff caching                    |
| [03 ingestion](docs/architecture/03-ingestion.md)                       | Write path, embeddings providers, deterministic relations, sweepers |
| [04 search & graph](docs/architecture/04-search-graph.md)               | Hybrid search, BM25 fusion, inference, entity traversal             |
| [05 merge & review](docs/architecture/05-merge-review.md)               | Merge requests, gates, threads, reviewers, saved filters            |
| [06 auth & ACLs](docs/architecture/06-auth-acl.md)                      | `AUTH_MODE`, the two guards, sessions, roles, audited graph query   |
| [07 client & errors](docs/architecture/07-api-client-errors.md)         | `make api-client`, `ApiErrorPayload`, the typed web client          |
| [08 events & live](docs/architecture/08-events-live.md)                 | Redis pub/sub, SSE, WS gateway, optimistic cache updates            |
| [09 web frontend](docs/architecture/09-web-frontend.md)                 | SSR shell, per-request isolation, cookies, hydration hazards        |

**Features** — [`docs/features/`](docs/README.md):

| #   | Feature              | One line                                                              |
| --- | -------------------- | --------------------------------------------------------------------- |
| 01  | Document view        | Full markdown + frontmatter via `GET /:id/content`                     |
| 02  | Search widget        | Filters applied post-ranking in PG under a 5× candidate over-fetch     |
| 03  | Editor               | Confluence-like rich editor; every block round-trips through markdown  |
| 04  | Dependent reindex    | One level of cascade on indexed revisions + live cache invalidation    |
| 05  | Revision viewer      | Revision list and line diff per document                               |
| 06  | Graph view           | Per-document subgraph built by BFS over the workspace relation graph   |
| 07  | Categorization       | `documents.category`, free text with a label fallback                  |
| 08  | Nesting              | `documents.parent_id` + `GET /v1/documents/tree`                       |
| 09  | AI assistant         | `ASSISTANT_PROVIDER`; review / suggest / related / ask                 |
| 10  | Activity feed        | `activity_log` + fire-and-forget `ActivityService.record`              |
| 11  | Projects             | The containment layer between tenant boundary and page                 |
| 12  | AI settings          | Per-workspace overrides of the `ASSISTANT_*` env block                 |
| 13  | Review mode          | Annotate a merge request's page like a PDF                             |
| 14  | Glossary             | Project-scoped vocabulary, linked at read time, never rewriting a page |
| 15  | Page comments        | Issue-shaped page: rail widgets + inline comment decorations           |
| 16  | Import               | Destination → Parse → Review wizard, one parser per format             |
| 17  | Workflows            | A configurable xstate graph of steps run against one page              |
| 18  | Internationalization | en + ru across API and web; document content is never translated       |
| 19  | Connectors           | External systems as sources and destinations                           |
| 20  | Agents               | A named, configurable actor behind every AI call                       |
| 21  | Agent mentions       | `@reviewer` in a discussion brings that agent into the thread          |
| 22  | Notifications        | The per-person layer over an otherwise broadcast event bus             |
| 23  | Identity             | Avatars and hover cards; initials are the normal state                 |
| 24  | Project page         | The read side of a project; people are derived, never assigned         |
| 25  | Web research         | `web_search` / `web_fetch` as tools, gated by source policies          |
| 26  | Connector staging    | Staged runs, review/step sync modes, per-page revert                   |
| 27  | Comment editing      | Edit/delete a comment; Comment vs. Start thread                        |
| 30  | GitHub repo picker   | A GitHub App installation replaces repo URL + PAT for git connectors   |
| 31  | Code research        | `code_*` tools over a connected repo; the archaeologist drafts pages for undeclared logic |

## Conventions

**Modules & processes**

- The house split is `*CoreModule` (services, controller-free, both processes) / `*QueueModule` (producer, both) / `*Module` (controllers, API-only) / `*WorkerModule` (processors, worker-only).
- Controllers pull `AccessService` and therefore the global `AuthModule`; **a controller-bearing module must never load in the worker.** When the worker needs a service, extract a `*CoreModule` and re-export it from the existing module so no call site changes.
- **The worker generates, the API publishes.** Anything that creates a page, opens a merge request or attributes an act to a person happens API-side, where a principal exists. The worker stages it and an API-side sweeper finishes it — which doubles as crash recovery.
- Any service injected into `McpService` must be **exported** by its module.
- A provider registered in a module that imports you is invisible — pass it as a call argument, not a DI token.
- Lift a shared helper into a leaf module rather than closing an import cycle.

**Data & migrations**

- **No FK on `workspace_id`, `user_id` or assignee-style columns.** House policy: it is what lets the `AUTH_MODE=none` dev principal, which has no `users` row, own data.
- A **NOT NULL column on a populated table** needs a backfill, which `make db-migrate-new` cannot express. Use `prisma migrate dev --create-only`, hand-edit to nullable → `UPDATE` → `SET NOT NULL`. `20260907160044_projects_layer` is the worked example.
- Denormalize at write time **and backfill in the migration** — a feed that starts empty on the day its column shipped is not a feed.
- Resolve a denormalized column centrally (in the recorder) rather than at every call site, so a new call site cannot forget it.
- A classifier is **derived, never stored** (`notificationCategoryFor`, `activityKindFor`), with an inverse so filtering stays in SQL.
- No stored aggregate tables — a `Promise.all` of counts over rows that already exist. A cached copy is a second answer to the same question.
- A **partial unique index** (`WHERE read_at IS NULL`) is not expressible in Prisma: use `updateMany`-then-insert. A race duplicates a row at worst, and it self-corrects on read.
- Idempotency is a **single guarded statement** — `updateMany({where:{status}})`, `jsonb_set`, or `INSERT … SELECT … WHERE NOT EXISTS`.
- Content dedupe is **per-branch** (`@@unique([documentId, branchId, contentHash])`): a merge revision legitimately repeats the source head's content on the target branch.

**API & errors**

- New routes need `@Access(role, source)` or they are authenticated-only with no workspace check. A new `WorkspaceSource` resolves `:id` → owning workspace **in PG before the handler runs**, so a cross-tenant id 403s.
- A route with no single workspace to resolve cannot use `@Access` — write an explicit assertion instead (`assertCanSeeUser`).
- Custom 4xx bodies use the **flat-extras pattern**: `ConflictException({statusCode, message, ...extras})`. `ApiExceptionFilter` hoists extras into `details`. **Never nest `details` manually.**
- Literal route segments must be declared **before** `@Get(':id')` — Nest matches in declaration order.
- Every new env var needs a **default**: `generate-openapi.main.ts` runs zod validation with no infrastructure.
- `AiUsageOperation` must gain a value for every new model call site.

**AI & providers**

- Provider resolution is always `resolveFor(workspaceId, purpose, pinnedId?)`, **first-hit-wins**: agent pin → purpose route → inline config → env.
- Settings rows are a **sparse override of a code default**; `null` means inherit. An empty table must reproduce the previous behaviour exactly.
- A tool allowlist **intersects, never unions** — a settings row must not widen what a model can reach.
- Env is a **ceiling, not a default** where it clamps a workspace setting, and the UI must show both what is asked for and what applies. A silent clamp lies about the configuration.
- Check permission **on execution, not on offer** — a turn outlives a settings change.
- Enforce at the point of action, never in the prompt: a rule that cannot be enforced is a rule that lies.
- Trust boundary: skills are trusted text; **document content, fetched bytes and plugin output are always wrapped untrusted.**
- One SSRF filter (`common/safe-url.ts`) and one credential store (`ai/secret-box.ts`, AES-256-GCM, write-only over the API) — one implementation is the only safe number.
- There is **no cron** in this repo: no `@nestjs/schedule`, no BullMQ repeatables. Scheduled work is a due check inside a fixed tick, with back-pressure (never a second run while one is in flight).

**Vocabulary**

- A closed catalogue lives in `packages/contracts` when a form, a guard and a worker registry must agree — three consumers of one constant cannot drift.
- A closed vocabulary must not promise a value the code never emits.
- A declaration is not a fact: if a guard, a sweeper and the UI disagree about what is runnable, they must all read the same predicate.
- Longest pattern / longest term wins, wherever precedence is needed.

**Web**

- Tab strips are hand-rolled (no tab library is installed), and `?tab=` is an **opening instruction, not two-way state**.
- Project-scoped Pinia stores expose `rescope()`, called from `projects.switchProject()`.
- Search filters are applied post-ranking against PG under the existing 5× over-fetch.
- `createI18nFor(locale)` is called **inside `createApp()`**, never at module scope, or concurrent SSR renders share a locale.
- Use the `lib/format.ts` Intl wrappers — a locale-less `toLocale*` follows the host, which during SSR is the server: a hydration mismatch.
- A preference the SSR pass must read before any JS runs is mirrored into a cookie (`kn_ws`, `kn_proj`, `kn_lang`, `kn_filterrail`).
- A map converted to hold message keys is only half the change — the render site must resolve them. A value from a known set still needs a fallback when the column is free text (`labelFor`).
- `<img>` cannot send an `Authorization` header: authorize, then 302 to a signed URL. Cache-bust reused object keys with `?v=<updatedAt>`.
- No favicons for third-party sites — never make a reader's browser request one.
- `ResponsivePopover`: `HoverCard` under `(hover: hover)`, `Popover` otherwise. A link nested inside a `<button>` is invalid markup.
- Fire-and-forget recorders (`ActivityService.record`, `AiUsageService.record`) never throw into a user request.
- xstate wizards: invoke a child machine at the **root**, not inside a step (a step re-creates it on every entry), give it **no final state** if you may step back into it, and report both ends upward.

## Gotchas

- `apps/api` is **ESM** (`"type": "module"`, NodeNext): relative imports need the `.js` suffix (`./app.module.js`), including from `.ts` sources. There is no `__dirname` — use `import.meta.dirname`.
- class-validator `@IsUUID()` rejects nil-style UUIDs (the version digit must be 1–5). The demo workspace is `11111111-1111-4111-8111-111111111111` (`DEMO_WORKSPACE_ID` in `apps/web/src/lib/api.ts`).
- `openapi-typescript` promotes any property declaring a `default:` in its Swagger decorator to **required** in the generated client. Describe the default in `description:` instead.
- A nullable DTO field needs an explicit `type:` in its Swagger decorator — `@ApiPropertyOptional({ nullable: true })` alone emits a typeless schema that becomes `Record<string, never>` and silently breaks the web typecheck at every call site.
- A **buildless workspace package consumed from source may not use relative cross-file imports, and may not use TS-only runtime syntax** (the **buildless package constraints**). Node will not resolve `./x.js` into a sibling `.ts`; an explicit `./x.ts` is rejected by any consumer that emits (TS5097); strip-only mode rejects parameter properties and enums. The escape is **package self-reference** (`@knowledge/contracts/core`). This fails **only at runtime** — `make check` passes clean either way, which is why `Dockerfile.api` ends with a real `import()` of every package entry.
- `pnpm dlx` can hang on interactive prompts in non-TTY runs — use `pnpm exec shadcn-vue add <component>` from `apps/web`.
- `corepack` does not exist on this Node install; pnpm is pinned only via the `packageManager` field.
- Reindexing is idempotent by design: `GraphService.upsertRevisionChunks` deletes the revision's chunks and vertex before recreating them, and the processor skips jobs already `completed`.
- Relation edge type names are **SQL-interpolated**, so every type is validated against `RELATION_EDGE_TYPES` in `GraphService`. **Never widen that list without keeping the allowlist check.**
- With the default `AUTH_MODE=none` every request passes as the dev principal, whose userId **is** the zeros `AUTHOR_ID_STUB`. Test ACLs and merge gates with a bootstrapped key, not in dev mode.
