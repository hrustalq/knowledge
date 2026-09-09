# 20 — Agents

Оригинал: «let's implement a full agentic workflow — agents configurable via
settings, and modify built-in agents; classificator should choose which agents
and model based on available ai providers and models; configure harness,
background workflows, automation»

## What this is

A named, configurable actor behind every AI call the product makes. An agent is
instructions + a tool allowlist + a model + an output contract, stored once and
reused — editable by a workspace admin, and shipped with ten built-ins that
cover every model call site that existed before this feature.

On top of that: a **router** that picks the agent and the model from what the
workspace actually has configured, and a **background surface** that lets an
agent run on a schedule and report what it found.

## Why

The agent tuple already existed in this codebase three times, anonymously:

| Where                                            | Had                                            | Missing                                   |
| ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------- |
| `ai_skills` (feature 12)                         | instructions, trigger words                    | tools, model, output contract             |
| `ai_settings.{chat,review,extraction}ProviderId` | model routing                                  | a closed three-value enum                 |
| `WorkflowStep` (feature 17)                      | `prompt` + `tools` + `skillIds` + `providerId` | inline per step; not nameable or reusable |

`WorkflowStep` is the tell. A workflow author was already writing the whole
tuple by hand, per step, with no way to name it or use it again — and
`step.tools` was **declared and ignored**, because `workflow.executors.ts`
called `client.chat` with no tool loop at all. The same file re-implemented
`AiSkillsService.renderPrompt`, because that service is API-only and the
executors run in the worker.

Three half-abstractions is one abstraction too few.

## Decisions

**Built-ins are code defaults with sparse override rows.** `ai_agents` stores
only what an admin changed; `null` means inherit. An empty table reproduces the
old behaviour of every call site exactly — which is the property the first phase
was verified against, by reconstructing each prompt from git and comparing byte
for byte. It is also what gives "reset to default" a meaning, and what lets a
release improve a shipped prompt for every workspace that never touched it.
Seeded rows would have frozen each workspace at its install date.

**Provider resolution delegates rather than replaces.** `AgentRegistryService`
folds default ⊕ row and then calls feature 12's `resolveFor`, so the chain grows
one link at the front — agent pin → purpose route → inline config → env — and
keeps every property it had: still first-hit-wins, and a disabled or deleted
profile still falls through instead of failing the call. `AiPurpose` survives as
the coarse bucket each built-in declares, so the routing UI keeps working for a
workspace that never opens the agents tab.

**The classificator is deterministic first.** An LLM that picks the model is
itself a call somebody had to pick a model for, so the choice of which model
runs the classifier can never itself be classified. The way out is that
capability, budget and enablement are _facts_: they are decided in code, and the
model is only ever asked to break a tie between candidates that already passed.
With no capable provider — or in the worker, where there is no classifier at all
— the router stops at the rules and is still correct, just less specific.

**A missing capability is a refusal, not a substitution.** `MODEL_CAPABILITIES`
is a code table with a per-profile override column, the shape `MODEL_PRICES`
already had, and for the same reason: any hardcoded list of models goes stale.
An unknown model is assumed to do tools and JSON but **not** vision. The
asymmetry is the whole point — a wrong "supports tools" guess fails loudly at
call time, while a wrong "supports vision" guess produces a confident
transcription of an image the model never saw, and nothing downstream can tell
that apart from a real one.

**The tool allowlist narrows and never widens.** An agent's `tools` is
intersected with what the harness already offers for that mode and surface. An
allowlist that could add a tool would let a settings row widen what the model
can reach, which is the one thing agent configuration must never do. The
built-in lists are exactly what the chat offered before this feature, so an
untouched workspace is unchanged and an admin who unticks a tool actually loses
it.

**Skills stay composable.** An agent _references_ skills rather than replacing
them: `ai_skills` is still picked in the composer and still matched by trigger
word, and an agent's own `skillIds` join that set. Merging the two concepts
would have cost the composability — three skills can apply to one turn, and one
agent cannot.

## Identity, and the defect it was written against

A background run stores `created_by` **NOT NULL** and rehydrates a real
`Principal` from `users` before it does anything, then asks the same
`AccessService.requireRole` an HTTP request asks. A disabled or demoted owner
fails the run; there is no service principal for it to become.

That is deliberately stricter than `workflow_runs.createdBy`, and the reason is
a live defect this feature was careful not to repeat. A trigger-started workflow
run sets no `createdBy`, so its model call bills `userId: run.createdBy ??
'workflow'` — a non-UUID into `ai_usage.user_id @db.Uuid`, whose insert then
fails and is swallowed. **Auto-triggered spend is invisible.** Relatedly,
`assertWithinBudget` was wired only into request paths, so no background work
checked a quota at all. Agent runs check it twice: at enqueue, and again in the
processor, because a queued run can wait long enough for the month's budget to
be spent by something else.

`AUTH_MODE=none` is the one accommodation: the dev principal's id is the zeros
stub and it has no `users` row, so it is short-circuited to `DEV_PRINCIPAL` —
the same allowance the merge gates already make for that identity, and a no-op
under `api-key`, where no real user can hold that id.

## Why the worker still cannot write

Splitting `AuthCoreModule` out of the guard-registering `AuthModule` made
`AccessService` available to the worker — which, incidentally, would now let
`MergeRequestsService` load there too. It is deliberately not loaded.

Feature 17's rule stands: **the worker generates, the API publishes.**
`AgentWorkerModule` provides `AssistantClient` directly and nothing that can
write. A background agent proposes; a person acts.

## Why the curator has no tool loop

Which pages exist, which have no relations, when each last changed — those are
queries, not judgements. The executor gathers them deterministically and spends
the model call only on the half that is actually judgement: duplication,
contradiction, gaps. That split is the one this codebase draws everywhere
between deterministic and inferred facts.

It also means orphan findings are exactly right rather than probable, a
workspace with no model configured still gets half an answer, and the write
tools never have to exist in the worker at all. The built-in declares
`requires: ['json']` rather than `['tools']`, because a declaration the executor
does not honour is worse than no declaration.

Every finding must cite pages that exist in the workspace; one that cites
nothing, or cites an id the model invented, is dropped before it is stored
(plan.md §12.7 — source-backed citations, never a bare LLM answer).

## Why scheduling is a sweeper and not a cron

This repo has no `@nestjs/schedule`, no `@Cron`, and no BullMQ repeatables.
Every `queue.add` is a one-shot with an explicit `jobId`, and the one
user-configurable schedule that already existed — `Connector.syncIntervalMinutes`
— is a due check inside a fixed five-minute tick. `AgentScheduleSweeper` is that
shape exactly, down to the back-pressure rule: never a second run while one is
in flight, so an agent slower than its interval falls behind rather than piling
up.

Schedules are off by default and need an owner and an interval before they can
be enabled, because the failure mode of unattended AI is an avalanche, not a
slow queue.

## Data model

| Table                       | Notes                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai_agents`                 | Sparse override of a built-in, or a workspace's own agent. Unique on `(workspace_id, key)`; a custom key may not shadow a built-in, or `resolve` would be ambiguous. Schedule columns live here rather than in a table of their own — a schedule _is_ a property of the agent. |
| `agent_runs`                | One background execution. `created_by` NOT NULL (above). `locale` frozen at enqueue, like `import_jobs.locale`. `findings` is `AgentFinding[]`.                                                                                                                                |
| `ai_providers.capabilities` | Admin-declared `AgentCapability[]`, overriding the model table. Same shape as the price overrides beside it.                                                                                                                                                                   |

## Modules

Five, following `import/` and `workflows/`:

- **`AgentCoreModule`** — registry + router, controller-free, loaded in both
  processes. Nothing in it may reach for anything the worker cannot load.
- **`AgentQueueModule`** — producer only, both processes.
- **`AgentWorkerModule`** — processor, executor, schedule sweeper. Worker only.
- **`AuthCoreModule`** — `AccessService` without the guards, re-exported by
  `AuthModule` so no existing importer changes.
- The admin write surface (`AiAgentsService`, `AgentRunsService`,
  `AgentTiebreakService`) lives in **`AiModule`**, API-only: editing an agent
  needs the plugin roster to validate a tool list, and the classifier needs
  `AssistantClient`.

The tiebreak is passed to `route()` as an **argument, not a DI token**.
`AgentCoreModule` is imported _by_ `AiModule`, so a provider registered there
would be invisible to the router — and the only implementation pulls
`DocumentsModule`. An argument makes the asymmetry explicit at each call site
instead of hiding it in module wiring.

## Routes

| Route                                  | Access | Notes                                      |
| -------------------------------------- | ------ | ------------------------------------------ |
| `GET /v1/ai/agents`                    | admin  | Effective roster: defaults ⊕ overrides     |
| `GET /v1/ai/agents/choices`            | viewer | Names only — no prompts, no tools          |
| `POST /v1/ai/agents`                   | admin  | A workspace's own agent                    |
| `PATCH /v1/ai/agents/:key`             | admin  | `null` on a field restores its default     |
| `DELETE /v1/ai/agents/:key/override`   | admin  | Reset a built-in                           |
| `DELETE /v1/ai/agents/:key`            | admin  | Custom only; built-ins reset or disable    |
| `POST /v1/ai/agents/route`             | viewer | Dry-run the router, with rejection reasons |
| `POST /v1/ai/agents/:key/run`          | editor | Runs as the caller, capped by their role   |
| `GET /v1/ai/agents/runs` · `/runs/:id` | viewer | Runs and their findings                    |

Agents are addressed by **key**, not id: a built-in has no row until it is
overridden, so it has no id to address. That means `workspaceId` always travels
in the body or the query, and the ACL source is `body`/`query` — no
`WorkspaceSource` resolver was needed.

## Web

A sixth and seventh tab on `/settings/ai`: **Agents** (roster, per-agent editor,
reset, capability warnings) and **Runs** (findings with links to the pages they
cite). Both follow `AiSkillsPanel`'s shape. The editor sends **only changed
fields** — sending an untouched one would turn a shipped default into an
override and freeze it against future releases.
