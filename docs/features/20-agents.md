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

This was written against a defect in `workflow_runs.createdBy`, which was
nullable: a trigger-started run had no owner, so its model call billed `userId:
run.createdBy ?? 'workflow'` — a non-UUID into `ai_usage.user_id @db.Uuid`,
whose insert failed and was swallowed, making auto-triggered spend invisible.
Relatedly, `assertWithinBudget` was wired only into request paths, so no
background work checked a quota at all.

Feature 17 has since been brought to this rule rather than left as the
counter-example: its column is NOT NULL, a triggered run executes as the
definition's author, and a definition without one does not auto-start. The
shared half lives in `AccessService.principalFor`, so the two processors cannot
drift apart on what a stored `created_by` means. Agent runs still check the
budget twice — at enqueue and again in the processor — because a queued run can
wait long enough for the month's budget to be spent by something else.

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

## The curator reads, but only after the queries are answered

Which pages exist, which have no relations, when each last changed — those are
queries, not judgements. The executor still gathers them deterministically and
spends the model call only on the half that is actually judgement: duplication,
contradiction, gaps. That split is the one this codebase draws everywhere
between deterministic and inferred facts, and it is unchanged.

What changed is what the judgement half can see. It used to receive a bare
listing — id, category, title, date — and be asked to find duplicates and
contradictions in it. Titles cannot answer that. A page called "Deploys" and a
page called "Release process" are either the same thing written twice or two
different things, and nothing in the listing says which. The curator now
declares `tools: [...READ_TOOLS]` and runs `runWithTools`, so it can open both
before claiming they conflict.

Every property the old split was protecting survives. Orphan findings are still
exactly right rather than probable, because the worker still computes them. A
workspace with no model configured still gets half an answer. And the write
tools still do not exist in the worker: what the curator gained is
`AssistantReadToolsService`, which reaches search, documents, prisma and access,
and nothing else.

The built-in now declares `requires: ['json', 'tools']`. The older note here
warned that a declaration the executor does not honour is worse than no
declaration — that still holds, so `curate()` honours it by **degrading rather
than refusing**: `'tools'` is filtered out of what counts as blocking, and a
model without tool support runs the original single-shot pass instead of no
model pass at all. Declaring it blocking would have turned a capability the
agent merely prefers into a reason to skip the work entirely.

Every finding must cite pages that exist in the workspace; one that cites
nothing, or cites an id the model invented, is dropped before it is stored
(plan.md §12.7 — source-backed citations, never a bare LLM answer).

## The cartographer keeps the split, but reads

docs/features/28 added a twelfth built-in on exactly this shape, and it is worth
naming here because it is the argument above applied a second time. Which pages
declare no relations, and which carry an `inferred` edge nobody ever confirmed,
are queries — so the worker answers them deterministically and the model is
spent only on which connection is real. `RUNNABLE_AGENTS` is
`curator | reviewer | glossarist | cartographer`.

That half of the split is unchanged. What changed is the other half. The
cartographer used to declare `tools: []` and answer from a single `client.chat`
call over a pre-baked listing — and the listing says what each page *declares*,
which is not the question. Whether a connection is real is in the prose, and the
agent could not open it. It now declares `tools: [...READ_TOOLS]` and runs
`runWithTools`, so it can search, read a page and walk the graph before
proposing anything.

Two details of that are load-bearing:

- The tools are the **read half only** — `AssistantReadToolsService`, split out of
  `AssistantToolsService` precisely so the worker can load it without
  `StorageService`, `MergeRequestsService` or anything else that writes. Feature
  17's rule is untouched: the worker generates, the API publishes.
- `requires` names `'tools'` so the roster shows honestly what the agent wants,
  but `mapRelations` filters `'tools'` out of what counts as *blocking* and falls
  back to the original single-shot call on a model without tool support. A bare
  `requires` entry would have skipped the model half altogether on those
  deployments, which is a regression dressed up as a capability check.

The JSON output contract moved with it: `response_format: json_object` suppresses
tool calls, so it can only be applied on the final, toolless round —
`runWithTools` takes a `jsonFinalRound` option that does exactly that.

It also gave `orphan` findings something to do. They were refused by the
merge-request proposal path because the fix is a relation and not prose; a
finding may now carry the relations it proposes, and Apply turns that into a
frontmatter merge request without a model rewriting the page.

## The tester fills a list it did not write

**`tester`** (#468) writes one API operation's QA test suite
([52](52-api-reference.md#test-suites-468)), on the `background` surface, the
`review` purpose, `requires: ['json']`, no tools. The curator's split again:
which cases an operation needs is `testCasesFor`, a pure function of the spec,
and the model is shown that list and asked only for a realistic baseline
request and the words for each case, as JSON keyed by case id. The spec
excerpt reaches it wrapped untrusted (`spec`). `buildTestSuite` completes any
case the model left out, and throws — failing the run — rather than store one
it cannot build honestly.

It is **not** in `RUNNABLE_AGENTS` and not triggerable: only Generate on an
operation card starts it (`trigger: 'manual'`, `subjectKey` = the cache key),
and only for a member holding `api-test-suites.generate`. The run checks that
capability again before it calls the model. An admin override of its
instructions or skills, or a change of its model, is part of the suite's cache
key, so the next Generate after one asks the model again. Its calls are billed
as `test-suite`.

## The linter and the auditor measure, and the harness decides

Two built-ins came with doc quality ([53](53-doc-quality.md)). Both run on the
`review` purpose, require `json` and get no tools: what they need is computed
before the call, the curator's split.

- **`linter`** checks text against a styleguide, on the `interactive` surface
  (`POST /v1/assistant/lint`, `knowledge_lint_draft`) and the `background` one
  (a merge request's style check). It is **not** in `RUNNABLE_AGENTS`, the
  sentinel's reasoning: a background run exists only for a check, and only
  `LintTriggerSweeper` starts one, with the new trigger `'merge-request'`. Its
  answer passes `readLintViolations`, which drops a rule id the styleguide
  does not hold and a quote the text does not contain, and takes the severity
  from the rule. The prompt says the same, but the gate is what holds.
  Disabling the agent turns the lint policy `off` everywhere.
- **`auditor`** scores pages, on the `background` surface only. It is in
  `RUNNABLE_AGENTS`, so it has a Run button and the ordinary schedule, off
  until someone sets one. Links, ownership and near-duplicates are facts the
  executor computes; the model is asked only for clarity, completeness and
  style, and that half is reused for a revision it already judged against the
  same rules. With no model to call, the facts are still written and the
  judgements are `null`. It writes `document_quality_scores` rows from the
  worker. That is the one write a background agent makes, argued in 53 as a
  measurement rather than a publication.

The glossarist changed with them. It reads the pages whose current head no
earlier succeeded run read (`details.glossaryScanned`), and each finding
carries the drafted `term`, so **Add to glossary** needs no model call.

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

A schedule can also run at a time of day (#70): `daily` at `HH:MM`, or
`weekly` on a set of weekdays, in an IANA timezone (null means UTC; the
editor fills in the browser's zone). The tick does not change. A slot is due
on the first tick at or after it, so precision is five minutes and the editor
says so. There are no cron expressions, because a syntax that promises
minute precision would misstate what the tick can do. Whether a schedule is
due is answered by one function, `nextScheduledRun` in
`@knowledge/contracts`. The sweeper, the summary's `nextRunAt` and the
editor's preview all call it. Slots are counted from the later of `lastRunAt`
and `schedule_changed_at`, which gives two guarantees: a worker that was down
across five slots runs once, and moving 09:00 to 08:00 at ten o'clock does not
fire the 08:00 slot the moment it is saved. A null `schedule_kind` is
`interval`, so rows written before #70 behave exactly as they did.

`AgentRunInput.documentIds` limits a curator, reviewer or glossarist run to
the named pages (`PAGE_SCOPED_AGENT_KEYS`). The pages are added to the
executor's query next to `visibilityWhere`, never instead of it, so naming a
page the owner cannot open gives the run nothing to read. It does not let the
run read that page. Event triggers depend on this: a "page merged" run reads
that page only.

Events start runs too, since #70: a page merged or indexed, a merge request or
pull request opened, a connector sync, a signed webhook, or a mention. They are
**not** a second scheduler. `AgentTriggerService` writes the same `agent_runs`
row the sweeper does, with `trigger: 'event'`, and enqueues it on the same
queue, so the processor, the owner rule and the budget check are shared. What
it adds is the guards an unattended source needs (enabled, filter, owner,
in flight per subject, a cooldown, a per-workspace cap). Triggers, recipes,
learnings and imported repository guidance are written up in
[49](49-agent-triggers.md).

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
| `GET /v1/ai/agents/choices`            | viewer | Names only — no prompts, no tools; `scope=all` names every agent, not just the offered ones |
| `POST /v1/ai/agents`                   | admin  | A workspace's own agent                    |
| `PATCH /v1/ai/agents/:key`             | admin  | `null` on a field restores its default     |
| `DELETE /v1/ai/agents/:key/override`   | admin  | Reset a built-in                           |
| `DELETE /v1/ai/agents/:key`            | admin  | Custom only; built-ins reset or disable    |
| `POST /v1/ai/agents/route`             | viewer | Dry-run the router, with rejection reasons |
| `POST /v1/ai/agents/:key/run`          | editor | Runs as the caller, capped by their role   |
| `GET /v1/ai/agents/runs` · `/runs/:id` | viewer | Runs and their findings                    |

Triggers, recipes, learnings and finding dismissal add routes of their own;
they are listed in [49 §Routes](49-agent-triggers.md#routes).
`POST /v1/ai/agents/runs/:id/findings/:index/add-term` (editor) turns a
glossarist finding into a glossary entry ([53](53-doc-quality.md)).

Agents are addressed by **key**, not id: a built-in has no row until it is
overridden, so it has no id to address. That means `workspaceId` always travels
in the body or the query, and the ACL source is `body`/`query` — no
`WorkspaceSource` resolver was needed.

## Web

A sixth and seventh tab on `/settings/ai` (sections since issue #182, at
`/settings/ai/agents` and `/settings/ai/runs`): **Agents** (roster, per-agent editor,
reset, capability warnings) and **Runs** (findings with links to the pages they
cite). Both follow `AiSkillsPanel`'s shape. The editor sends **only changed
fields** — sending an untouched one would turn a shipped default into an
override and freeze it against future releases.
