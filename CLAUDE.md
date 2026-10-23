# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dynamic Knowledge Platform — a graph + semantic documentation store with a REST API, a GitLab-style revision DAG, and an MCP interface for agents. Phases 0–5 and product features 01–27 are implemented.

**This file carries code-level conventions and gotchas only.** The narrative of how any one area works lives elsewhere:

| Document                                            | Answers                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| [`plan.md`](plan.md)                                | What we set out to build — design intent, phased plan |
| [`docs/architecture/`](docs/architecture/README.md) | How it is actually built, one doc per logic layer     |
| [`docs/features/`](docs/README.md)                  | The product layer, one doc per feature (01–47)        |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                | Process: branches, commits, release, rollback         |
| [`docs/versioning.md`](docs/versioning.md)          | What the version number promises                      |

Where the code has diverged from `plan.md`, the architecture docs say so. `plan.md` is not retro-edited to match the code.

## Commands

The root `Makefile` is the entry point — run `make help` for the full list.

```bash
make setup              # first-time: env files → pnpm install → infra → migrations → build
make dev                # infra + api :3000 (Swagger /docs) + web :5173 + ingestion worker (turbo watch)
make kill               # kill this repo's dev processes; kill-all also stops infra
make dev-worker         # only the BullMQ ingestion worker (already part of `make dev`)
make dev-mcp            # MCP server on stdio (knowledge_* tools); the API also serves them at POST /v1/mcp
make dev-learner        # the learner (#305); idles unless LEARNER_ENABLED=true

make verify             # PRE-PUSH GATE: db-generate + lint + typecheck + deps + test (no build)
make check              # CI gate: lint + typecheck + deps + test + build
make deps               # dependency-cruiser: process boundaries, layering, cycles, buildless rules
make deps-baseline      # re-record known violations (shrink-only: drops fixed ones, never adds)
make smoke              # health-check every service
make backtest           # retrieval/pipeline backtest. ARGS="--generate --limit 120" | "--report"
make tune               # propose search knobs + capture thresholds from the backtest datasets; writes no setting. ARGS="--workspace <id>"
make collab-load        # shared-draft load test against running APIs (AUTH_MODE=none, COLLAB_ENABLED=true). ARGS="--docs 50 --peers 5"

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

**The worker is a second entrypoint of `apps/api`, not a separate app** — `src/main.ts` (HTTP) vs `src/worker.main.ts` (`createApplicationContext(WorkerModule)`, no HTTP), alongside `src/mcp.main.ts` (third), `src/scripts/generate-openapi.main.ts` (fourth) and `src/learner.main.ts` (fifth, `createApplicationContext(LearnerModule)`: the learning-loop timer, no HTTP, no Redis). `IngestionModule` (producer) is imported by both; **`IngestionWorkerModule` only by the worker** — import it into `AppModule` and the API process starts consuming jobs.

See [`docs/architecture/01-entrypoints-modules.md`](docs/architecture/01-entrypoints-modules.md) for the module-split rules the dependency-cruiser configs enforce.

## Where each area is documented

**Layers** — [`docs/architecture/`](docs/architecture/README.md):

| Doc                                                                         | Covers                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [01 entrypoints & modules](docs/architecture/01-entrypoints-modules.md)     | Five entrypoints, Core/Queue/API/Worker split, buildless packages   |
| [02 persistence & revisions](docs/architecture/02-persistence-revisions.md) | Branches, revision DAG, compare, diff caching                       |
| [03 ingestion](docs/architecture/03-ingestion.md)                           | Write path, embeddings providers, deterministic relations, sweepers |
| [04 search & graph](docs/architecture/04-search-graph.md)                   | Hybrid search, BM25 fusion, inference, entity traversal             |
| [05 merge & review](docs/architecture/05-merge-review.md)                   | Merge requests, gates, threads, reviewers, saved filters            |
| [06 auth & ACLs](docs/architecture/06-auth-acl.md)                          | `AUTH_MODE`, the two guards, sessions, roles, audited graph query   |
| [07 client & errors](docs/architecture/07-api-client-errors.md)             | `make api-client`, `ApiErrorPayload`, the typed web client          |
| [08 events & live](docs/architecture/08-events-live.md)                     | Redis pub/sub, SSE, WS gateway, optimistic cache updates            |
| [09 web frontend](docs/architecture/09-web-frontend.md)                     | SSR shell, per-request isolation, cookies, hydration hazards        |

**Features** — [`docs/features/`](docs/README.md):

| #  | Feature              | One line                                                                                                                                                                               |
| -- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 | Document view        | Full markdown + frontmatter via `GET /:id/content`                                                                                                                                     |
| 02 | Search widget        | Filters applied post-ranking in PG under a 5× candidate over-fetch                                                                                                                     |
| 03 | Editor               | Confluence-like rich editor; every block round-trips through markdown                                                                                                                  |
| 04 | Dependent reindex    | One level of cascade on indexed revisions + live cache invalidation                                                                                                                    |
| 05 | Revision viewer      | Revision list and line diff per document                                                                                                                                               |
| 06 | Graph view           | Per-document subgraph built by BFS over the workspace relation graph                                                                                                                   |
| 07 | Categorization       | `documents.category`, free text with a label fallback                                                                                                                                  |
| 08 | Nesting              | `documents.parent_id` + `GET /v1/documents/tree`                                                                                                                                       |
| 09 | AI assistant         | `ASSISTANT_PROVIDER`; review / suggest / related / ask                                                                                                                                 |
| 10 | Activity feed        | `activity_log` + fire-and-forget `ActivityService.record`                                                                                                                              |
| 11 | Projects             | The containment layer between tenant boundary and page                                                                                                                                 |
| 12 | AI settings          | Per-workspace overrides of the `ASSISTANT_*` env block                                                                                                                                 |
| 13 | Review mode          | Annotate a merge request's page like a PDF                                                                                                                                             |
| 14 | Glossary             | Project-scoped vocabulary, linked at read time, never rewriting a page                                                                                                                 |
| 15 | Page comments        | Issue-shaped page: rail widgets + inline comment decorations                                                                                                                           |
| 16 | Import               | Destination → Parse → Review wizard, one parser per format                                                                                                                             |
| 17 | Workflows            | A configurable xstate graph of steps run against one page                                                                                                                              |
| 18 | Internationalization | en + ru across API and web; document content is never translated                                                                                                                       |
| 19 | Connectors           | External systems as sources and destinations                                                                                                                                           |
| 20 | Agents               | A named, configurable actor behind every AI call                                                                                                                                       |
| 21 | Agent mentions       | `@reviewer` in a discussion brings that agent into the thread                                                                                                                          |
| 22 | Notifications        | The per-person layer over an otherwise broadcast event bus                                                                                                                             |
| 23 | Identity             | Avatars and hover cards; initials are the normal state                                                                                                                                 |
| 24 | Project page         | The read side of a project; people are derived, never assigned                                                                                                                         |
| 25 | Web research         | `web_search` / `web_fetch` as tools, gated by source policies                                                                                                                          |
| 26 | Connector staging    | Staged runs, review/step sync modes, per-page revert                                                                                                                                   |
| 27 | Comment editing      | Edit/delete a comment; Comment vs. Start thread                                                                                                                                        |
| 30 | GitHub repo picker   | A GitHub App installation replaces repo URL + PAT for git connectors                                                                                                                   |
| 31 | Code research        | `code_*` tools over a connected repo; the archaeologist drafts pages for undeclared logic                                                                                              |
| 32 | Tree drag-and-drop   | Reparent + reorder by drag, keyboard and picker; `POST :id/move` places among siblings                                                                                                 |
| 32 | Tracker handoff      | (doc `32-connector-work-items.md`, the other 32) `connector_work_items` anchored on an issue/conflict/verification/document row, one per connector; `TrackerAdapter` beside `ConnectorAdapter` (GitHub, Jira, GitLab via `TrackerRegistry`); status `open` / `in_progress` / `done` / `wont_do` derived by `workItemStatusFor` through the connector's status map, never stored; sync is one `syncDecision` (newer side wins) in the API-only `WorkItemSyncSweeper` (in `ConnectorsModule`, never in a module MCP imports); a tracker close never verifies a page; identity = `external_identities`, attribution only, unmapped is `tracker:<id>`; ticket text is summary + link + `knowledge-ref:` footer, never content; every read takes an `AccessScope` |
| 33 | Connect AI           | MCP over HTTP at `/v1/mcp` per caller, named/narrowed API keys, per-client configs, generated SKILL.md                                                                                 |
| 34 | Editor assistant     | Left sidebar chat that reads the draft and streams `edit_draft` suggestions into the page                                                                                              |
| 35 | PR drift check       | A PR queues the `sentinel` to judge the tied pages; the API proposes fixes, flags them `requested` (→ `outdated` on merge) and comments once                                           |
| 36 | GitHub access        | Connector card listing installation grants vs App requests vs feature needs; OAuth reconnect/disconnect                                                                                |
| 37 | AI-readable output   | llms.txt / llms-full.txt per workspace & project, .md per page, Accept: text/markdown, page AI actions menu                                                                            |
| 38 | Answer provenance    | `[S#]` citations settled by `finalizeCitations`, per-source provenance + derived confidence; votes, issue reports → sentinel → MR, surveyor gap findings, feedback backtest            |
| 39 | Page verification    | Owner, review interval, `requested`/`outdated` flags, archive; one predicate `verificationStateFor` read everywhere, `trustWeight` in search; no agent verifies                        |
| 40 | Knowledge health     | `/v1/knowledge-health` dashboard + bulk actions over one SQL CTE (`healthFilterSql` inverts `HEALTH_FILTERS`); sparse settings over `VERIFICATION_*`                                   |
| 41 | Mail                 | SMTP behind a BullMQ `mail` queue: the API enqueues, only the worker sends (`MAIL_TRANSPORT=log` default); verify/reset/invite, `AUTH_REQUIRE_VERIFIED_EMAIL`                          |
| 42 | Page templates       | Own tables with immutable versions, never indexed; built-ins are code, rows override; `{{x}}` rendered by `@knowledge/contracts/templates`; text always `wrapUntrusted`                |
| 43 | Share links          | `kp_` public link to a page/subtree, opt-in twice (env ceiling × workspace setting); resolved afresh per request, out-of-scope 404s; web `/s/*` is a separate SSR entry                |
| 44 | Published sites      | Project/subtree as a read-only docs site; public routes read only snapshot rows, never a head; TXT-proven custom domains, snapshot FTS, audiences, public Ask + widget                 |
| 45 | Export               | Page/subtree/project → zip, html, pdf (Gotenberg) or docx via `export_jobs`; the worker asks the web `/_internal/export/render` for HTML, writes docx itself from `markdownTokens`; `ExportSweeper` purges expired |
| 46 | Repo wiki            | `codebase` connector wiki + Releases steered by `.knowledge/wiki.yml`; `effectiveWikiConfig` (code ← file ← connector, `WIKI_MAX_EFFORT` ceiling); Mermaid only via `wiki-diagrams.ts` |
| 47 | Chat bots            | Telegram + Time bots answer as the **linked** person, never a bot principal; groups silent until bound; turns run API-side via `AssistantService.runChatTurn`                          |
| 48 | Page permissions     | Page/project restrictions, groups, guests, access requests; view is intersective down the tree; every retrieval path takes an `AccessScope`, PG has the final say; connectors mirror source ACLs |
| 49 | Agent triggers       | Events, a signed webhook, a mention or a time of day start agent runs; `AgentTriggerService` is the only `trigger:'event'` writer; recipes, admin-approved learnings, repo guidance as disabled skills |
| 50 | Agent memory         | `knowledge_capture_*` → staged row → raw-cosine dedupe → MR with `provenance: 'captured'`; `capture` key passes editor only on `{ capture: true }` calls; head-less new pages hidden via `pending_merge_request_id`; terms via the inbox |
| 51 | Component pages      | `component:` → `component_declarations`; each pull replaces `code_imports` + `code_files`; rules only in `component-match.ts`; `code` edges via `replaceCodeFacts`; Used by is read-time under `AccessScope`; drafts = archaeologist run + `proposePage` |
| 52 | API reference        | `documents.kind` openapi/asyncapi; ingestion branches on kind → markdown projection + `api_operations` + revision-scoped `spec` `DESCRIBES`; `{param}` folds in `normalizeEntityKey`; slug pinned; try-it proxy is env-ceilinged, never MCP; `breakingBlocks` gates merge; synced spec changes always MR |
| 53 | Doc quality          | Styleguide = `ai_skills` `kind='styleguide'`, project replaces workspace; `readLintViolations` drops unknown rules/ungrounded quotes, severity is the rule's; MR lint = added lines only, sweeper-triggered per head, published API-side; `lintGate` is the one predicate (fail-open); scores are append-only rows the worker writes |
| 54 | Enterprise auth      | OIDC/SAML/LDAP providers per workspace (`platformWide` opt-in), JIT only on a verified address in `allowedDomains`; token via a 60 s fragment exchange code; `RoleSyncService` is the one non-manual membership writer; enforced SSO inside `requireRole` (`AuthPolicyService`, 30 s cache); SCIM `kscim_` is a credential, never a principal |
| 55 | Learning loop        | Attribution columns on `agent_runs`/`ai_usage`/`answer_feedback` (no ledger table); `outcomeFor` ↔ `outcomeCaseSql` derived on read, a count below 20 runs never a rate; `learner.main.ts` (5th entrypoint, `LEARNER_ENABLED` off) clusters dismissals/MCP failures with the ACL in the query → `coach` → `proposed` `derived` rows only; derived ≤ half the budget, never displacing manual; `mcp` is in `LEARNING_TARGETS`, never `BUILT_IN_AGENT_KEYS`; `make tune` replays one search per query through `rankPool`, holdout must agree, prints PATCH bodies and writes nothing |
| 56 | Co-editing           | One Yjs draft per (page, branch) in `collab_drafts`, never a revision; Hocuspocus embedded behind `/v1/collab` (API-only, `kt_` tickets, page permissions, per-document **reasons** not close codes); server seeds via `@knowledge/editor-schema`; publish = ordinary finalize that rebases the draft; reset moves `reset_at` + device copies carry a generation; collab mode never `setContent`; `COLLAB_ENABLED` default off; MCP draft tools are HTTP-only, passed to `buildServer` as an argument, and suggest through `CollabGateway.writeDraft` |
| 57 | Temporal graph       | Per-revision rows stamped `validFrom/validTo/lineage` from PG (`revisionStamps`, order-free) + edge `ingestedAt/expiredAt/retractedBy`; `live` stays the current view, `asOfEdgeClause`/`asOfChunkClause` the only as-of predicates; `TemporalResolverService` (date, `rev:`, `tag:`); `knowledge_conflicts` = one guarded upsert per fingerprint (dismissed stays dismissed); propose links via `AgentFindingsService`, a merge resolves; communities withheld whole |
| 58 | Usage analytics       | Event rows only (`page_views`, `search_queries`, `mcp_tool_calls`), every number a read-time rollup; channel resolved once by `channelFor`, class derived by `trafficClassFor` (human/assisted/agent); web reads only from the page's beacon, never `GET /content`; `reader_key` HMAC per workspace, no `user_id`; one unread/dead predicate in `read-signals.ts`; repeat searches collapse only in `searchCtesSql`; query text wrapped untrusted |
| 59 | Chat harvest          | (#382: a `harvest` connector kind — `linear` — claims a resolved, labelled item in `connector_harvests` from its webhook; the API-only `ConnectorHarvestSweeper` re-reads it and harvests as the resolver when a mapped editor, else deletes the claim; `HarvestService` lives in `HarvestCoreModule`.) A linked editor's `capture` / DM forwards / 📌 (Time) / ✍ (Telegram) → `HarvestService` (API-side): regex mask (`harvest-mask.ts`) → `harvester` (no tools, JSON) → `planCaptures` drops a term not verbatim in the thread and an answer citing no page the asker's search handed out → `CaptureService.capture` as the asker; `origin` is server-set, never a DTO field or model output; the chat reply is counts + inbox link, never a title; a reaction from anyone else is silent; Telegram threads come from `chat_buffered_messages` (masked on write, admin opt-in after a group notice, TTL on the answer sweeper, never read by search/assistant/MCP) |
| 60 | Chat search          | A per-binding `searchable` switch (admin, notice first) keeps masked messages in `chat_messages` → `ChatIndexSweeper` (worker, fixed tick) packs thread windows into `chat_chunks` + a `ChatChunk` vector index; never the harvest buffer; `CHAT_SEARCH_RETENTION_DAYS` is a ceiling, off/unbind/`/forget` purge at once; `canSeeChat` decides readable bindings in PG **before** either leg; never mixed into page search; `search_chat`/`knowledge_search_chat` wrap untrusted as `conversation`; a `kind: 'chat'` source, so page-only readers test `isPageSource`, never `!isWebSource` |
| 61 | Question flows        | Code-defined scenarios asked one question at a time (`capture-decision`, `mark-outdated`); `nextQuestion`/`validate`/`prune` in `@knowledge/contracts/flows` are pure, so a flow is rebuilt from its answers — no flow state table; options are workspace data under the caller's `AccessScope`, never model output; `FlowsService` is the one server half; web = `prompt` frame + structured `answer` (only the open or last-answered question, else 409 `flow-answer-stale`); MCP = `elicitInput` on stdio, `needs_input` over stateless HTTP (`runFlow`); `answers` joins no tool list |
| 62 | QA fixtures and runs  | `kind: test-fixture` documents (calls + captures + manual notes + teardown, `{{secret.x}}` never a literal) bound per suite in `api_test_bindings`, bound hashes in the suite cache key; `testRunPlan` holds placeholders only and `runTestPlan` is the one walker (browser, proxy, agent, worker); every send is `ApiTryService` (now in the controller-free `ApiRunnerCoreModule`) — proxy mode, source policies, spec-declared servers, `api.try` audit; `api-test-suites.run` checked at route, MCP guard and execution; server runner = `API_TEST_RUNNER_MODE` ceiling × workspace opt-in, `api_test_environments` secret-box write-only, the API stores a queued plan and the job carries only the run id, last 20 runs per suite; `/qa` state is `qaSuiteStatusFor` over the panel's own cache key, never stored |

## Conventions

**Modules & processes**

- The house split is `*CoreModule` (services, controller-free, both processes) / `*QueueModule` (producer, both) / `*Module` (controllers, API-only) / `*WorkerModule` (processors, worker-only).
- Controllers pull `AccessService` and therefore the global `AuthModule`; **a controller-bearing module must never load in the worker.** When the worker needs a service, extract a `*CoreModule` and re-export it from the existing module so no call site changes.
- **The worker generates, the API publishes.** Anything that creates a page, opens a merge request or attributes an act to a person happens API-side, where a principal exists. The worker stages it and an API-side sweeper finishes it — which doubles as crash recovery.
- Any service injected into `McpService` must be **exported** by its module.
- Every MCP tool handler starts with its `guard.*(…, role)` call — the per-tool twin of `@Access`, same role as the REST route it mirrors. A new write tool also joins `WRITE_TOOLS` (`mcp-tools.ts`), which drives `readOnlyHint` and hides it from read-only keys; the spec fails if that list names a missing tool. An agent-memory write joins `CAPTURE_TOOLS` instead (disjoint from `WRITE_TOOLS`) and guards with `guard.captureWs` / `guard.captureDoc` — the only calls that lift a `capture` key to editor.
- An API key only narrows (`principal.apiKey`, enforced in `requireRole`). A non-GET route without `@Access` refuses read-only keys unless marked `@ReadKeyOk()`.
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
- A citation rule is a prompt; the enforcement is `finalizeCitations` at the end of the turn. **Never trust a `[S#]` the model wrote** — a label the turn did not hand out is stripped and counted, and the stored text keeps the `[S#]` form (a bare `[2]` collides with prose and reference links). `assessAnswer` reads only what the harness observed; no model self-grading. Provenance is resolved **once per answer** by `ProvenanceService`, never per tool call.
- One SSRF filter (`common/safe-url.ts`) and one credential store (`ai/secret-box.ts`, AES-256-GCM, write-only over the API) — one implementation is the only safe number.
- There is **no cron** in this repo: no `@nestjs/schedule`, no BullMQ repeatables. Scheduled work is a due check inside a fixed tick, with back-pressure (never a second run while one is in flight).

**Page permissions** (feature 48)

- **Every method that returns pages takes a required `AccessScope`**, and every store read (`GraphService`, the fulltext provider) a required `DocumentAclFilter`. A system job passes `systemScope(workspaceId)`, which is greppable on purpose. The PG post-filter (`visibilityWhere`) is authoritative; the `aclNodes` stamps on the stores are only a prefilter.
- The visibility rule has three spellings in `permissions/access-scope.ts` (`canSee`, `visibilityWhere`, `visibilitySql`) pinned against each other in `permissions.spec.ts`. Change all three or none.
- A workspace-level route a guest may call opts in with `@Access(…, { guests: true })`, which promises the handler filters by scope.
- Output posted where others read it (a thread, an agent run, a group chat) is retrieved under `PermissionService.audienceScope`, never the author's scope alone.
- A refused page is a 403 `{ canRequestAccess, resourceType, resourceId }` for a member and a 404 for a guest. **Never put a title in either.**

**Entity keys & hierarchy**

- An entity key is **canonical or it is a fork**. `normalizeEntityKey` (contracts) folds NFC, case and inner whitespace; `GraphService` folds again at the recorder and `assertCanonicalKey` throws at the edge writer. Fold **at the top of a write method**, never inside `createRelationEdge` — the guarded DELETEs read `targetKey` first, so folding later duplicates an edge per re-post.
- Folding cannot know `сервис:биллинг` and `service:billing` are one service. That is `EntityAlias`, resolved at **write** time so the graph holds one vertex and every walk is unchanged. Resolution is **one hop** — the guarded insert refuses anything that would chain.
- A relation type is normalized before the guard, never inside it: `normalizeRelationType` accepts `depends_on`, `Depends On` and `зависит_от`; `isAuthorableRelationType` stays exact-case.
- `documents.path` is `/rootId/…/selfId/`, **delimited at both ends** — that is what makes the cycle check `parent.path.includes('/' + id + '/')` and stops `/a/ab/` matching `/a/abc/`. Maintained app-side in `DocumentsService` only (every other writer routes through `createDocument`); a move shifts the subtree in **one** statement inside the same transaction.
- Hierarchy still does not enter the graph. Features 08/11 stand: it reaches the model through `list_document_tree` and breadcrumbs on tool results, not through a `PART_OF` edge, and `EMBED_RECIPE` is untouched so nothing re-embeds.
- A page created head-less behind a merge request (a capture, a chat save) carries `documents.pending_merge_request_id` until the merge. **Every new surface that enumerates pages applies `LISTED_PAGE` / `listedSql`** (`common/listed-page.ts`). It is not part of `visibilityWhere`: that decides who may open a page, and the page stays readable by id for its reviewer.

**Vocabulary**

- A closed catalogue lives in `packages/contracts` when a form, a guard and a worker registry must agree — three consumers of one constant cannot drift.
- A closed vocabulary must not promise a value the code never emits.
- A declaration is not a fact: if a guard, a sweeper and the UI disagree about what is runnable, they must all read the same predicate.
- Longest pattern / longest term wins, wherever precedence is needed.

**Web**

- Tab strips are hand-rolled (no tab library is installed), and `?tab=` is an **opening instruction, not two-way state**.
- **Never call `editor.isActive()`/`editor.can()` in a template.** `@tiptap/vue-3` makes editor state reactive, so it re-renders the component on every transaction. Editor chrome renders from `editorStreams(editor).format$`, and anything that reads layout listens to `frame$` (once per animation frame).
- Project-scoped Pinia stores expose `rescope()`, called from `projects.switchProject()`.
- Search filters are applied post-ranking against PG under the existing 5× over-fetch.
- `createI18nFor(locale)` is called **inside `createApp()`**, never at module scope, or concurrent SSR renders share a locale.
- Use the `lib/format.ts` Intl wrappers — a locale-less `toLocale*` follows the host, which during SSR is the server: a hydration mismatch.
- A preference the SSR pass must read before any JS runs is mirrored into a cookie (`kn_ws`, `kn_proj`, `kn_lang`, `kn_filterrail`).
- The client's first render must use what the **server rendered with**, not what the client would pick: the locale comes from `<html lang>` (the server falls back to `Accept-Language`, which storage cannot see), and a component that renders *before* a later `onServerPrefetch` fills the store it reads (the rail's tree vs. a page's prefetch) waits for `onMounted` — the serialized state is the end of the render, not the moment it drew (#278). Data the shell needs is loaded *before* the render instead (`prefetchShell` in `entry-server.ts`, #279).
- A map converted to hold message keys is only half the change — the render site must resolve them. A value from a known set still needs a fallback when the column is free text (`labelFor`).
- `<img>` cannot send an `Authorization` header: authorize, then 302 to a signed URL. Cache-bust reused object keys with `?v=<updatedAt>`.
- No favicons for third-party sites — never make a reader's browser request one.
- `ResponsivePopover`: `HoverCard` under `(hover: hover)`, `Popover` otherwise. A link nested inside a `<button>` is invalid markup.
- A store's in-flight dedupe keys its WeakMap by `toRaw(this)`: in dev, Pinia's devtools call every options-store action on a fresh Proxy, so `this` never matches (#279).
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
- **Relation edges are never deleted on reindex or by a person** (#81): a fact a re-extraction drops is expired, one a person removes is retracted (`retractedBy: user:<id>`), and the old revision's rows are closed by their `validTo`. Only `deleteDocumentGraph` hard-deletes. A new edge writer must go through `createRelationEdge` (it stamps `ingestedAt`) and must never revive an expired row.
- Relation edge type names are **SQL-interpolated**, so every type is validated against `RELATION_EDGE_TYPES` in `GraphService`. **Never widen that list without keeping the allowlist check.**
- A new `AUDIT_ACTIONS` value needs en/ru labels (`security.audit.actions.<action with . → _>`) **and** a literal `action: '<value>'` somewhere in `src` — `audit.service.spec.ts` fails otherwise, and a ternary does not count.
- With the default `AUTH_MODE=none` every request passes as the dev principal, whose userId **is** the zeros `AUTHOR_ID_STUB`. Test ACLs and merge gates with a bootstrapped key, not in dev mode — and `make auth-bootstrap` makes a **platform admin**, who bypasses every page restriction. `test/page-permissions.e2e-spec.ts` creates its own non-admin people.
