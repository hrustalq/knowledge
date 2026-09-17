# 01 — Entrypoints & module boundaries

The rules in this document are enforced by `.dependency-cruiser.cjs` at the repo
root and by `apps/api/.dependency-cruiser.cjs`, both of which quote it. `make deps`
is the gate; breaking one of these is a build failure, not a review comment.

## Four entrypoints, one `src` tree

**The worker is a second entrypoint of `apps/api`, not a separate app.** All four
share one dependency graph, one Prisma client and one config schema; what differs
is which root module each composes.

| Entrypoint                             | Root module    | Process                                          |
| -------------------------------------- | -------------- | ------------------------------------------------ |
| `src/main.ts`                          | `AppModule`    | HTTP: controllers, WS gateway, API-side sweepers |
| `src/worker.main.ts`                   | `WorkerModule` | BullMQ processors, no HTTP                       |
| `src/mcp.main.ts`                      | `McpModule`    | MCP over stdio                                   |
| `src/scripts/generate-openapi.main.ts` | `AppModule`    | Schema emission — builds the app, never listens  |

The worker uses `createApplicationContext(WorkerModule)`: no HTTP server is
created at all. The fourth exists so `make api-schema` can scan route metadata
without touching infrastructure — it creates the Nest app **without `init()` or
`listen()`**, though the env file is still required because `src/config/env.ts`
validates with zod at import time. That is why **every new env var needs a
default**: a variable with no default cannot be resolved by a process that has no
infrastructure, and schema generation fails before it reads a single route.

## The module split

A module that carries controllers pulls `AccessService`, which pulls the global
`AuthModule`. Load that in the worker and the worker starts answering HTTP
concerns it has no business knowing about — or, worse, fails to boot in a way that
only shows up when a queue drains. The house shape, repeated verbatim across
ingestion, import, workflows, connectors and agents:

| Module          | Contents                       | Loaded by          |
| --------------- | ------------------------------ | ------------------ |
| `*CoreModule`   | Services, controller-free      | API **and** worker |
| `*QueueModule`  | The producer (`queue.add`)     | API **and** worker |
| `*Module`       | Controllers, API-side sweepers | API only           |
| `*WorkerModule` | Processors, schedule sweepers  | Worker only        |

Consequences worth stating outright:

- **Never import `IngestionWorkerModule` into `AppModule`** — the API process
  would start consuming ingestion jobs.
- When the worker needs a service that lives behind controllers, **extract a
  `*CoreModule` and have the existing module import and re-export it**, so no call
  site changes. `AiCoreModule` is the precedent; `DocumentsCoreModule`,
  `ProjectsCoreModule`, `ActivityCoreModule`, `GlossaryCoreModule` and
  `AuthCoreModule` all followed it.
- `EventsModule` is publisher-only and worker-safe; `EventsApiModule` holds the
  subscriber, the SSE controller and the WS gateway and is API-only. Same
  rationale as `GraphQueryModule` and `IngestionAdminModule`.
- **A provider registered in a module that imports you is invisible.** When the
  only implementation lives upstream, pass it as a call argument rather than
  injecting it as a DI token — this is why `AgentRouterService.route()` takes its
  tiebreaker as a parameter.
- **Controller-free Core/Client splits never import their parent back**, which is
  what keeps them `forwardRef`-free.

**The worker generates, the API publishes.** Anything that creates a document,
opens a merge request or attributes an act to a person happens on the API side,
where there is a principal to attribute it to. The worker leaves such work in a
staged state and an API-side sweeper finishes it — which doubles as recovery when
a request dies mid-write. `WorkflowMaterializeSweeper`, `ConnectorConflictSweeper`
and `MentionReplySweeper` are the three instances.

## MCP is the third entrypoint

`src/mcp.main.ts`, run by `make dev-mcp`. Three things about it are load-bearing:

- **stdio belongs to JSON-RPC.** Nest logging is disabled, because anything
  written to stdout corrupts the protocol stream. `abortOnError: false` so boot
  failures reach stderr instead of vanishing.
- **MCP tool names forbid dots**, so tools are named with underscores —
  `knowledge_search`, `knowledge_compare_revisions` — mapping 1:1 onto the dotted
  names in [plan.md §9](../../plan.md). Without this note plan.md reads as simply
  wrong against the code.
- **Any service injected into `McpService` must be exported by its module.**
  `SearchModule` exports `SearchService` for exactly this reason.

## Buildless workspace packages

`@knowledge/contracts`, `@knowledge/workflow` and `@knowledge/observability` are
consumed **from source** — their `exports` maps point at `.ts` files and nothing
ever builds them. That gives both apps a zero-step shared vocabulary and costs a
constraint no typechecker will enforce (the **buildless package constraints**):

- Node will not resolve a relative `./x.js` specifier into a sibling `.ts`.
- An explicit `./x.ts` resolves at runtime but is rejected by any consumer that
  emits (**TS5097**), and `allowImportingTsExtensions` is illegal alongside emit,
  so `apps/api` can never accept it.
- Strip-only mode rejects **parameter properties** (`constructor(readonly x: T)`)
  and **enums**.

The escape is **package self-reference**: `import type { X } from
'@knowledge/contracts/core'` is neither relative nor `.ts`, so Node resolves it
through the package's own `exports` map and an emitting `tsc` accepts it. This is
what lets a buildless package be split across many files —
`packages/contracts` has ten domain directories with one `exports` entry each;
`packages/workflow` is still a single file and could be split the same way.

**The trap: this fails only at runtime.** `make check` passes clean either way,
which is why `Dockerfile.api` ends with a `node --input-type=module` import of
every package entry — a build failure now, instead of a 3 a.m. production one.

## Contracts as the single vocabulary

`packages/contracts` holds plain request/response types shared by api and web.
Keep it free of Prisma and server imports **and of runtime dependencies** — zero
deps is what lets both an emitting Nest build and a Vite bundle consume it from
source. Types are named to map onto MCP tools (`knowledge.search` →
`SearchService`).

Cross-domain references import through the package's own name
(`@knowledge/contracts/core`), never a relative path. Because consumers only ever
import the barrel, moving a type between domains touches no call site.

A **closed catalogue belongs here** whenever a form, a guard and a worker registry
must agree on the same list — `CONNECTOR_KIND_INFO`, `WORKFLOW_STEP_KINDS`,
`importFormatFor`, `BUILT_IN_AGENT_KEYS`, `AGENT_MENTION_ATTR`,
`GLOSSARY_BOUNDARY_BEFORE`. Three consumers reading one constant cannot drift;
three copies of a regex can, and did.

## Related

- [02 — Persistence & revisions](02-persistence-revisions.md)
- [07 — Generated client & error contract](07-api-client-errors.md) — the fourth
  entrypoint's output
- [plan.md §9](../../plan.md) — the MCP tool catalogue
