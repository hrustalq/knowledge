# 17 — Dynamic document workflows

## What this is

A workspace-configurable graph of steps that, run against one page, produces the
next level of detail as reviewable drafts: an entity fans out into use cases,
each use case into API endpoints and frontend pages. Every step parks its result
on the run; nothing enters the page tree until a person approves it.

A run is a long-lived, interruptible process. It survives a worker crash, a
deploy and a week of nobody clicking Approve, and resumes exactly where it
parked.

Three ways in: a Workflows widget on any page, the `/workflows` section, and an
opt-in event trigger. Definitions are authored on a drag-and-drop canvas under
`/settings/workflows`.

## Why the machines are a shared package

`packages/workflow` is buildless and single-file, like `@knowledge/contracts`,
and is imported by the API, the worker and the browser.

Three consumers ask the same question. The API validates an incoming event
before it writes anything; the worker decides what runs next; the web decides
whether to render Approve, Retry, Skip and Reject. Compiling one machine in all
three is what makes it structurally impossible for the reviewer to be offered a
button the server will refuse — `WorkflowNodePanel.vue` calls the very function
`WorkflowsService.sendNodeEvent` is about to call.

The same argument covers the graph compiler: `validateGraph` runs in the editor
on every keystroke, in the API before a write, and in the worker before a run
starts, so a definition that saved cleanly cannot blow up mid-run on something
structural. The editor says "the graph has a cycle: a → b → a" the instant you
draw it, and is right because it is the server's own answer.

There is a second reason, and it is about safety rather than consistency.
XState's `setup({ guards })` resolves implementations by name in code, so a
stored definition only ever _names_ steps and transitions. A "dynamic" workflow
is therefore data, never executable content arriving from a database row.

Two constraints fell out of consuming a package from source: Node strips types
only from the entry file and will not follow a relative specifier into a sibling
`.ts`, so the package is one file; and strip-only mode rejects TypeScript
parameter properties, so the two error classes assign their fields by hand.

## Why the fan-out tree is rows, not actors

XState v5 persists a spawned-child tree, and modelling the fan-out that way was
the obvious first design. It was rejected: the tree would live as opaque JSON
inside the run row, and the feature has to answer "every node awaiting review in
this project" — which a blob cannot.

So the machines govern **lifecycle** and `workflow_run_nodes` holds the
**shape**. A node's state is one enum in a column, which is what lets the run
list, the status counts and the rail's "3 to review" all be SQL. The run's
snapshot, which carries counters and history rather than structure, is JSON.

## Why the worker generates and the API publishes

`DocumentsModule` will not load in the worker — its `MergeRequestsService`
depends on `AccessService` from the global auth module, which the worker has no
reason to carry. This was checked by booting the worker with it, not assumed.

That constraint turned into the rule the feature rests on: **the worker
generates, the API writes to the page tree.** Nothing a model produced reaches
the knowledge base except through a request a person made.

Auto-approved steps are the exception that proves it. A step marked
"publish without review" still lands its node in `materializing`; the worker
stops there, and `WorkflowMaterializeSweeper` — which runs in the API process,
where documents can be written — finishes the job under the run's creator. That
is still an authenticated decision: an admin marked the step auto-approve and a
person started the run. The sweeper doubles as the recovery path for the
interactive route, so a request that dies between the status write and the
document write leaves a node to be finished rather than a stranded run.

## Who a run executes as

`workflow_runs.created_by` is NOT NULL, and every node rehydrates that user into
a real `Principal` before it does anything — then asks the same
`AccessService.requireRole` an HTTP request asks, and the same
`assertWithinBudget`. A disabled or demoted owner fails the node. There is no
service principal for it to become.

That is a correction, not an original decision. The column was nullable, so a
trigger-started run had no owner, and its model calls billed `userId:
run.createdBy ?? 'workflow'` — a non-UUID into `ai_usage.user_id @db.Uuid`,
whose insert failed and was swallowed. **Auto-triggered spend was invisible**,
and no background path checked a quota at all. Feature 20 found this while
deciding how its own runs should work, wrote down the opposite rule, and this
is that rule brought back here.

The identity a trigger runs as is the **definition's author** — the person who
wrote the chain and turned auto-start on, which is the same act as an admin
enabling an agent schedule and naming its owner. A definition without an author
does not auto-start; it is skipped and logged, exactly as
`AgentScheduleSweeper` skips an agent with no `scheduleOwner`. Nothing here
invents an identity to keep a trigger alive.

The check is per node rather than per run because a run can sit
`awaiting-review` for a week: the owner who was an editor when it started may
be neither by the time the next node fires. `AccessService.principalFor` holds
the rule — including the dev/MCP stub accommodation — so this processor and the
agent one cannot drift apart on it.

## Why a run is one job per node

The processor runs a single node per BullMQ job, not a run per job. A run is
therefore only ever "in progress" for as long as one step takes: killing the
worker loses at most that step, and nothing about a run lives in process memory.
`WorkflowSweeper` returns nodes stuck in `running` to `pending` and re-queues
them, so the snapshot remembers _where_ a run was and the sweeper puts the work
back. Together they are what "interruptible and resumable" actually means here.

Claiming is a guarded `updateMany` from `pending` to `running`, so two workers
racing a re-delivered job never ask the model the same question twice.

## Why auto-start is hedged about

The failure mode of an event trigger is not a slow queue, it is an LLM
avalanche: one edit to a widely-referenced page fanning out into dozens of model
calls, repeatedly, across a workspace. Four guards, none optional:
`trigger.autoStart` is false on new definitions; the page's category must match;
a definition that already has a run — in flight _or_ finished — for that page is
skipped, so re-running is a deliberate act; and
`WORKFLOW_AUTOSTART_MAX_ACTIVE` (default 5) caps triggered runs per workspace.
Workflow events never trigger workflows, or a run's own output would restart the
chain that produced it.

## Data model

| Table                  | Notes                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_definitions` | `graph` Json (`{ steps, layout }`), `trigger` Json, `version` bumped only by a graph write. Optional `project_id` — the same chain means different things in two products.                                      |
| `workflow_runs`        | `definition_snapshot` freezes the graph at start, so editing a definition cannot change what a run in flight is doing (the reasoning that makes revisions immutable). `snapshot` is the persisted xstate state. |
| `workflow_run_nodes`   | Self-FK `parent_id` — this is the entity → use-case → endpoint tree. `draft` Json is the reviewable intermediate result; `document_id` is set only on publication.                                              |

The step catalogue (`WORKFLOW_STEP_KINDS`) is closed: `ai.generate` (fan-out),
`ai.draft` (writes one page), `search` (deterministic, no model), `review` (a
human gate). Each maps to an executor in `WorkflowExecutors`.

`use-case` was already in `DOCUMENT_CATEGORIES` and `IMPLEMENTS` already in
`RELATION_EDGE_TYPES`, so the example chain needed no new vocabulary. Provider
resolution is feature 12's unchanged — `resolveFor(workspaceId, 'chat',
step.providerId)` — so a workflow honours routing, budgets and the usage log
without knowing they exist; `AiUsageOperation` gained `'workflow'`.

## Modules

Four, following `import/`'s split. `WorkflowCoreModule` (runner, no controllers)
is imported by both sides so a run is advanced through the same code in either
process — the shape `AiCoreModule` has under `AiModule`. `WorkflowQueueModule`
is producer-only. `WorkflowsModule` is API-only. `WorkflowWorkerModule` belongs
to the worker entrypoint alone, and provides `EventsSubscriber` and
`AssistantClient` directly rather than importing the modules that own them:
each needs almost nothing, while `EventsApiModule` carries the SSE controller
and the WS gateway and `AssistantModule` pulls in `DocumentsModule`.

## Routes

| Route                                        | Access         | Notes                                                    |
| -------------------------------------------- | -------------- | -------------------------------------------------------- |
| `GET/POST /v1/workflows`                     | viewer / admin | definitions                                              |
| `GET/PATCH/DELETE /v1/workflows/:id`         | viewer / admin | 409 on delete while runs are in flight                   |
| `POST /v1/workflows/:id/validate`            | viewer         | compiles without saving — the editor's check             |
| `GET /v1/workflows/runs`                     | viewer         | filters + `counts` for every status under the same scope |
| `POST /v1/workflows/runs`                    | editor         | 409 when a run is already in flight for that page        |
| `GET /v1/workflows/runs/:id`                 | viewer         | run, frozen graph, node tree                             |
| `POST /v1/workflows/runs/:id/events`         | editor         | `PAUSE` / `RESUME` / `CANCEL`                            |
| `PATCH /v1/workflows/runs/:id/nodes/:nodeId` | editor         | edit a draft                                             |
| `POST .../nodes/:nodeId/events`              | editor         | `APPROVE` / `REJECT` / `SKIP` / `RETRY`                  |
| `GET /v1/documents/:id/workflow-runs`        | viewer         | the rail widget                                          |

Definitions are `admin` because a workflow decides what the assistant writes
into a workspace — the same bar as the AI settings that decide how. Runs are
`editor`, approval included: approving creates a page, so it wants exactly the
authority editing a page wants. New `WorkspaceSource` values
`workflow-definition` and `workflow-run` resolve the workspace in PostgreSQL
from the id, so another tenant's run id is a 403 before the handler runs.

MCP gained `knowledge_list_workflows`, `knowledge_start_workflow` and
`knowledge_get_workflow_run`. Approval is deliberately absent: it writes pages,
and stdio has no principal to attribute that to. An agent can start a chain and
watch it; a person still decides what gets published.

## Limits

Three-way content merges are not attempted anywhere here — a run writes new
pages, it never edits existing ones. A rerun against a page that already has a
run must be started by hand, and produces a second set of pages rather than
reconciling with the first. The `search` step attaches its hits to the node
input but no executor consumes them yet; `ai.draft` reads the source page and
the parent item only, capped at 24 000 characters, because a chain that pastes
a whole subtree into each prompt walks off the end of a context window halfway
down. Definition edits do not migrate runs in flight, by design. Failed nodes
retry up to `WORKFLOW_MAX_ATTEMPTS` and then wait for a person.
