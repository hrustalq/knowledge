# 49 — Agent triggers, time-of-day schedules, recipes and learnings

Issue [#70](https://github.com/hrustalq/knowledge/issues/70), shipped as seven
PRs (#206–#212). Before it, a background agent ([20](20-agents.md)) ran when a
person pressed **Run now** or when an interval came round, and nothing it was
told stuck: a finding judged wrong came back on the next run, and a correction
typed into a thread was gone once the thread scrolled away.

The milestone gives agents three things a team running them unattended needs:
a reason to start (an event, a webhook, a mention, a time of day), a way to be
set up without reading this document (recipes), and a memory for corrections
(learnings, finding dismissal, and the guidance files already in a
repository).

This document is the product layer. Scheduling mechanics are in
[20 §Why scheduling is a sweeper](20-agents.md#why-scheduling-is-a-sweeper-and-not-a-cron),
the bus in [08](../architecture/08-events-live.md), and the mention reply this
extends in [21](21-agent-mentions.md).

## What shipped

| Part                       | What it does                                                                                      | Phase |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ----- |
| Page-scoped runs           | `AgentRunInput.documentIds` limits a curator, reviewer or glossarist run to named pages           | 1     |
| Time-of-day schedules      | `daily` / `weekly` at `HH:MM` in an IANA timezone, beside the existing interval                   | 1     |
| Event triggers             | `agent_triggers` rows start runs when a page is merged or indexed, an MR or PR opens, a sync ends | 2     |
| Webhook and mention        | A signed POST, or `@agent` in a discussion, starts a run                                          | 3     |
| Digest agent and recipes   | A `digest` built-in, and one-press setups for three common jobs                                   | 4     |
| Learnings and dismiss      | Person-approved corrections reach prompts; a dismissed finding is not re-reported                 | 5     |
| Repo guidance import       | `AGENTS.md`, `CLAUDE.md` and friends become disabled, reviewable skills                           | 6     |
| UI validation              | An `/impeccable` pass over every surface above                                                    | 7     |

## Triggers

### Vocabulary

`AGENT_TRIGGER_EVENTS` in `@knowledge/contracts` is the product's names, and
`AGENT_TRIGGER_EVENT_SOURCES` maps each to the bus types it is heard on. The
DTO, the listener and the editor's picker all read those two constants, so they
cannot disagree about what "a merge request was opened" means.

| Event                  | Heard on                                          | Filter fields                     | Subject key        |
| ---------------------- | ------------------------------------------------- | --------------------------------- | ------------------ |
| `page.merged`          | `merge-request.merged`                            | categories, branch                | `doc:<id>`         |
| `page.indexed`         | `revision.indexed`                                | categories, branch                | `doc:<id>`         |
| `merge-request.opened` | `merge-request.created`, `repo.pull-request.opened` | categories, connectorIds, branch | `mr:<id>`          |
| `connector.synced`     | `connector.run.succeeded`                         | connectorIds                      | `connector:<id>`   |
| `webhook`              | — fired inline by `AgentWebhookController`        | —                                 | `webhook:<delivery>` |
| `comment.mention`      | — fired inline by `MentionRepliesService`         | categories                        | `doc:<id>`         |

`page.indexed` rather than `document.updated`: the latter fires on every
autosave of a draft, the former once per revision that reached the index.
Without a `branch` filter it hears only a page's default branch, because a
draft branch being edited is not "the page changed". It also skips a revision
created before the trigger and any revision it already fired for, so the
dependent-reindex cascade ([04](04-dependent-reindex.md)) and a forced reindex
start nothing.

`AGENT_TRIGGER_FILTER_FIELDS` decides which filter fields an event keeps. A
field the event has no dimension for would never match, so the API drops it
rather than storing a trigger that silently never fires. `agentTriggerEventsFor`
narrows the picker per agent: the archaeologist reads one repository, so it is
offered only `merge-request.opened` and `connector.synced`, and only a
page-scoped agent is offered `comment.mention`.

`connector.run.succeeded` carries no `documentId`. The listener treats it as a
workspace-scoped subject (`connector:<id>`), which `WorkflowTriggerService`
never had to.

### The guards

`AgentTriggerService.fire` (`apps/api/src/agents/agent-trigger.service.ts`) is
the **only writer of `trigger: 'event'` rows**. Its guards are feature 17's,
for the reason they exist there: the failure mode of an always-on trigger is an
avalanche, one busy page fanning out into model calls on every edit. Each
returns its own `TriggerSkip` reason, so each is observable on its own and
covered by `apps/api/test/agent-trigger.service.spec.ts`.

| Order | Guard                                                                  | Skip reason         |
| ----- | ---------------------------------------------------------------------- | ------------------- |
| 1     | The trigger is enabled (off on creation)                               | `disabled`          |
| 2     | The event passes `matchesTrigger` (type, project, filter)              | `filter`            |
| 3     | There is an owner to run as                                           | `no-owner`          |
| 4     | The agent is enabled, has a `background` surface, is in `RUNNABLE_AGENTS` | `agent-unavailable` |
| 5     | A connector-scoped agent's event names a repository                    | `no-scope`          |
| 6     | The subject is new to this trigger (revision, delivery id)             | `already-seen`      |
| 7     | The owner and workspace are within budget                              | `budget`            |
| 8     | No run of this agent is pending or running for the subject             | `in-flight`         |
| 9     | The cooldown for (trigger, subject) has passed                         | `cooldown`          |
| 10    | Fewer than `AGENT_TRIGGER_MAX_ACTIVE` triggered runs are in flight     | `cap`               |

The revision and delivery dedupe, guards 8–10 and the insert run under
`pg_advisory_xact_lock(hashtext('agent-trigger:<workspaceId>'))`, so two events
landing together cannot both pass them. The processor checks the budget again,
as it does for every run.

**A cooldown replaces workflows' "once per page".** That guard exists to stop a
run's own output from re-triggering it. An agent run writes no pages, it
proposes, so the chain cannot feed itself. The cooldown (60 minutes unless set,
`AGENT_TRIGGER_COOLDOWN_MINUTES`) bounds the other side: a page merged ten
times in an hour is one run.

**Self-trigger suppression is structural.** The listener hears four bus types
and no `agent.*`, `workflow*` or `ai.*` event is among them. The other two
callers are a person (a mention) or a system outside (a webhook).

### Identity

A triggered run has an owner, and it executes and bills as that person, the
rule [20 §Identity](20-agents.md#identity-and-the-defect-it-was-written-against)
set for every background run. For a trigger the owner is **whoever last enabled
it**. It is never a DTO field, so an admin cannot make a run execute as someone
else. A recipe writes its triggers disabled with no owner for the same reason.
`AccessService.principalFor` re-checks the owner's role when the run executes,
so a demoted owner's runs fail rather than run on a stale role.

A mention passes the commenter instead, through `fire`'s `FireOptions`: the
person who typed `@reviewer` addressed the agent, so the run is theirs, in
their language. That is also why a mention trigger may have no owner at all.

### Where it runs

| Piece                         | Module                                   | Process |
| ----------------------------- | ---------------------------------------- | ------- |
| `AgentTriggerService`         | `AgentTriggerCoreModule` (controller-free) | both    |
| `AgentTriggerListener`        | `AgentWorkerModule`                      | worker  |
| `AgentWebhookController`      | `AiModule`                               | API     |
| Mention firing, reply sweeper | `DocumentsModule` (`MentionReplySweeper`) | API     |
| `AgentTriggersService` (CRUD) | `AiModule`                               | API     |

The listener resolves an event's facts in PostgreSQL once and then fires each
enabled trigger in the workspace in turn. Both processes need
`AGENT_TRIGGERS_ENABLED=true`: the worker to hear the bus, the API to serve the
webhook route (404 while off) and to start mention runs (mentions get the
ordinary reply while off). `ListAgentTriggersResponse.listening` tells the
editor which state it is in.

**The bus does not redeliver.** An event published while the worker is down
starts no run. That is accepted for triggers, which are a convenience over an
event and not a queue. The webhook path is not affected: it inserts inline.

## Webhook triggers

`POST /v1/ai/agents/triggers/:id/webhook` is `@Public()` and authenticates by
HMAC. The signature is `sha256=` plus the hex HMAC-SHA256 of
`<timestamp>.<raw body>`, under the headers in `AGENT_WEBHOOK_HEADERS`
(`X-Knowledge-Signature`, `X-Knowledge-Timestamp`, `X-Knowledge-Delivery`).
`verifyHmacSha256` in `apps/api/src/common/hmac.ts` does the constant-time
compare, and the PR drift check's `verifyHubSignature` now uses it too.

The checks run cheapest-first, and the order is the contract:

1. 404: the kill switch is off, the id is unknown, or the trigger is not a webhook.
2. 413: the body is over `AGENT_WEBHOOK_MAX_BYTES`, checked before hashing.
3. 401: the signature is wrong, or the timestamp is more than
   `AGENT_WEBHOOK_TOLERANCE_SECONDS` from the server clock.
4. 400: the delivery id is missing or malformed.
5. 202 with `{ runId }`, or `{ runId: null, skipped }` naming the guard.

A delivery id is deduplicated **for good**, not only while a run is in flight,
since a sender retrying one delivery must not start two runs however long after.
The workspace is read from the trigger row and nowhere else.

The body is kept as `input.payload`, cut to 8 000 characters, and reaches the
model only through `runBrief()` in `agent.executor.ts`, inside
`wrapUntrusted(…, 'webhook')`. The secret is a `secret-box` envelope, shown
once on **Create secret** or **Rotate secret** and never again. Rotating stops
the old secret at once, so the editor asks first. Without
`SETTINGS_ENCRYPTION_KEY` the button answers 409.

There is no throttler in the repo. The bounds on a webhook are the HMAC, the
delivery dedupe, the workspace cap and the budget.

## Mention triggers

**The run's summary is the reply.** When an editor mentions a curator, reviewer
or glossarist that has an enabled `comment.mention` trigger whose filter takes
the page, `MentionRepliesService.handleMention` starts a run scoped to that page
instead of the feature-21 chat turn. The agent's placeholder comment is linked
to the run by `document_comments.agent_run_id` or
`merge_request_comments.agent_run_id`. `MentionReplySweeper` (API, 60-second
tick) fills it from the finished run with the summary, the first five findings
and a link, guarded on the placeholder still being pending.

- Viewers, agents without such a trigger, and a server with triggers off get the
  ordinary reply, byte for byte as before.
- A run that cannot start (in flight, cooldown, cap, budget) is explained in the
  placeholder.
- A run-linked placeholder is exempt from the 10-minute stale timeout. Its
  backstop is 24 hours.
- The subject key is `doc:<id>`, the same as page events, so a mention run and a
  `page.merged` run on the same page hold each other back. New mention triggers
  default to cooldown 0, because a person typing is already the rate limit.

## Schedules and page scope

Time-of-day schedules are described in
[20 §Why scheduling is a sweeper](20-agents.md#why-scheduling-is-a-sweeper-and-not-a-cron).
In short: one predicate, `nextScheduledRun` in contracts, answers "when is this
due" for the sweeper, for `nextRunAt` on the summary and for the editor's
preview. A worker that was down across several slots runs once, and an edit
never fires a slot it moved into the past (`schedule_changed_at`). Precision is
the five-minute tick, and the editor says so.

`AgentRunInput.documentIds` (at most 20) is honoured by the agents in
`PAGE_SCOPED_AGENT_KEYS`: curator, reviewer, glossarist. The pages are added to
each executor's query **beside** `visibilityWhere`, never instead of it, so
naming a page the owner cannot open gives the run nothing to read. A page event
sets `documentIds = [documentId]`, which is what makes a `page.merged` run read
the merged page and nothing else.

## Digest and recipes

The `digest` built-in is background-only with read tools. Its window starts at
the previous **successful** digest run, falls back to 7 days, and is capped at
31. Its facts come from the source tables, not `activity_log`: new pages, pages
whose default branch gained an indexed revision, merged merge requests, and
finding counts per agent. All of them are read under the run's audience scope
([48](48-page-permissions.md)), so the digest lists only pages the whole
workspace can open.

The model writes only the summary and the highlights. Grounding is three
functions in `agents/digest.ts`: `readDigestHighlights` keeps a highlight only
if it cites a listed page, `keepKnownLinks` unlinks any `/documents/<id>` the
model invented, and `digestMarkdown` builds every list and link from the facts.
A quiet period produces a summary with no draft and no model call. The first
finding carries a `draft`, and the existing **Create page** path publishes it as
the person who presses it, in the workspace's first project.

`AGENT_RECIPES` in contracts holds three setups, applied by
`POST /v1/ai/agents/recipes/:recipe/apply` through `AgentRecipesService`:

| Recipe               | Agent      | Schedule           | Trigger            |
| -------------------- | ---------- | ------------------ | ------------------ |
| `weekly-digest`      | digest     | Mondays 09:00      | —                  |
| `freshness-sweep`    | curator    | Mondays 08:00      | `connector.synced` |
| `glossary-suggester` | glossarist | —                  | `page.merged`      |

A recipe writes through `AiAgentsService.update` and
`AgentTriggersService.create`, so new-trigger defaults live in one place.
Everything it writes is disabled and ownerless, and the dialog then opens the
agent so an admin can turn it on. Applying again keeps any schedule the agent
already has and any trigger for the same (agent, event). The response's
`created` says what this press wrote. Notes are written in the applier's
language and schedules in the browser's timezone.

## Learnings

A learning is a correction a person taught an agent. It is stored in
`agent_learnings`, for one agent or all (`agent_key` null), and for one project
or all.

- **Only `active` text reaches a prompt, and only an admin makes a learning
  active.** That is the rule skills already follow: the text is trusted because
  a person approved it. An editor, or an MCP client through
  `knowledge_propose_agent_learning`, can only propose.
- `AgentLearningsService.promptFor` renders a `<team-guidance>` block of the
  newest `AGENT_LEARNINGS_MAX` (20) active rows, up to 4 000 characters, cached
  for 30 seconds per workspace.
- It is injected in three places: the chat turn (with the grounding page's
  project), mention replies (with the page's project), and every background
  executor through `AgentExecutor.guidance(run, agent)`, which replaced the
  eight separate skill renders. The glossarist executor has no prompt of its own
  and so receives none.
- Provenance (`source_kind`, thread, run and finding index, page, merge request)
  is kept so the **Learnings** panel can link back to where it came from.

**Dismiss** sets `dismissedAt` and `dismissedBy` on a finding with a guarded
`jsonb_set`, and optionally creates a proposed learning with its id written back,
all in one transaction. Three concurrent presses produce one dismissal and one
learning. A dismissal is only useful if the next run knows about it, so
`dismissedPrompt` hands an agent the titles of findings dismissed on its last
ten succeeded runs (at most 20) as quoted data, with an instruction not to
report them again.

## Derived learnings (#305)

The learner is a fifth `apps/api` entrypoint, `learner.main.ts`
(`createApplicationContext(LearnerModule)`). It loads no controller, gateway,
processor or sweeper of the other processes, and `make deps` enforces that.
It is off by default (`LEARNER_ENABLED=false`); a disabled learner boots and
idles. It writes proposals only. A derived learning is always `proposed`, and
an admin activates or archives it on the same PATCH route as any other.

**Clock.** `LearnerTicker` fires every `LEARNER_TICK_MS` (15 minutes) and passes
over each workspace at most once a day. A tick that finds a pass still running
starts nothing. The due check is in memory, so a restart makes every workspace
due once more. That is safe because a pass is idempotent.

**Derivation**, per workspace:

1. **Read.** Findings dismissed by a person within `LEARNER_WINDOW_DAYS` (30),
   citing at least one page. Every cited page must be listed and open to the
   whole workspace (`visibilitySql` over `systemScope` clamped to the workspace
   audience, in the query). A finding citing a restricted page, or anything
   under one, never enters.
2. **Cluster.** Grouped by agent and by the project of the first cited page,
   then clustered greedily by raw cosine to a running centroid at
   `LEARNER_CLUSTER_THRESHOLD`. Findings are embedded on the fly and never
   stored.
3. **Qualify.** A cluster needs `LEARNER_MIN_DISMISSALS` (3) findings from
   `LEARNER_MIN_PEOPLE` (2) distinct dismissers. Three dismissals by one person
   do not qualify.
4. **Fold or write.**
   - A cluster sharing a finding with a proposed or active learning for the same
     agent and project folds the new findings into that row's `evidence`, in one
     de-duplicating statement. A fourth similar dismissal therefore never inserts
     a second row.
   - A cluster sharing a finding with an archived learning is an admin's "no",
     and nothing is written.
   - Otherwise the `coach` drafts one correction from the findings, which are
     wrapped untrusted. A draft whose text is within the threshold of an
     existing proposed or active learning for the target folds into it.
     Anything else becomes a new `proposed` row with `source_kind = 'derived'`,
     `evidence` (run ids and finding indexes) and `created_by` = the zeros stub.

**Coach.** `coach` is a built-in agent, resolved through `resolveFor` like any
other, so it can be pinned to a provider or disabled. Its usage rows are
`operation = 'coach'` and billed to the zeros stub. Its "quote nothing, name no
page" rule is only a prompt. The ACL filter in step 1 is the enforcement.

**Budget.** `choosePromptLearnings` picks hand-written learnings first, exactly
as before. Derived ones then take the room left, but never more than half of
`AGENT_LEARNINGS_MAX` or half of the 4 000 characters. A derived learning never
displaces a manual one.

**Lifecycle.** For each active learning, `AgentOutcomesService.beforeAfter`
counts the agent's succeeded runs on each side of its approval:

- `after` is every run whose `learning_ids` contain it.
- `before` is every attributed run created before the approval. Runs from before
  the ledger (`learning_ids` NULL) are on neither side.

When both sides have at least `LEARNER_MIN_RUNS` (20) runs and the dismissal
rate did not drop, the learner sets `archive_proposed_at` and stores the counts
in `archive_check`. The learning stays active. An admin either archives it or
presses **Keep**, which clears the flag and records `keptAt`. A re-approval
starts a new period.

**Review.** The **Learnings** panel marks derived learnings with a badge and
shows their evidence. A finding is titled only when the viewer can open every
page it cites. The rest count as "+N not visible to you", without titles. A
flagged learning shows its before/after counts with **Archive** and **Keep**.

### Learnings for MCP agents (#305, phase 3)

External agents connected over MCP (Claude Code, Cursor and the rest) are a
learning target, `mcp` (`MCP_LEARNING_TARGET`), not an agent. It is in
`LEARNING_TARGETS`, which only learnings code reads, and not in
`BUILT_IN_AGENT_KEYS`, so the registry, the agent UI and `resolveFor` never see
it. A custom agent may not take the key.

**Delivery.** `McpService.instructionsFor` appends the caller's active `mcp`
learnings to `MCP_INSTRUCTIONS`, and `knowledge://skill` (plus `GET
/v1/mcp/skill` and the `guide` prompt) gets the same list as a **Team
guidance** section. One renderer, `renderMcpLearnings`, writes both.

- Per workspace the caller reaches: workspace-wide `mcp` learnings, plus those
  for a project it can see. A key narrowed to projects gets only those
  projects' learnings.
- Learnings for every agent (`agent_key` NULL) are not included. They were
  written for the platform's own agents.
- The budget and the derived/manual split are `choosePromptLearnings`, as for
  any agent.
- Instructions travel only on `initialize`, so the HTTP controller reads
  learnings only for that message. A failed read falls back to the static
  instructions. The stdio server reads them once at startup.

**Failures.** `LearnerService.mcpFailures` feeds the same clustering as agent
findings, under agent `mcp`:

- a capture an MCP agent sent (not the assistant's, not a chat harvest) that
  a person rejected in the inbox, or whose merge request a person closed
  unmerged. The person is the `activity_log` actor (`capture.rejected`,
  `merge-request.closed`), and a reject reason becomes the detail;
- a downvote on an answer an MCP agent built from `knowledge_search`
  (`surface = 'mcp'` with a `trace_id`), scoped to the first cited page's
  project.

A `duplicate` capture is not a failure: dedupe worked, and counting it would
teach agents to stop capturing. The ACL rule is the findings' rule, in the
query: every page a row names (a capture's target, the page ids in its payload,
the page its merge request proposes, an answer's citations) is open to the
whole workspace, and a capture's project is not restricted. Evidence stores
`{ captureId }` or `{ feedbackId }` next to `{ runId, findingIndex }`.
`listForViewer` titles a capture only when the viewer may see its project and
the pages it names (the captures inbox's rule), and an answer only when the
viewer may open every page it cites.

### Calibration

`make backtest ARGS="--learner"` measures the threshold for the configured
embedding model. It reads only. The input is 38 built-in labelled findings
(`learner/learner-calibration.ts`): eight recurring mistakes with four findings
each, one in Russian, plus six one-offs, two of which share a mistake's `kind`
for a legitimate reason. `--workspace <id>` adds that workspace's style findings,
labelled by rule.

The run clusters the findings with the learner's own `clusterFindings` at every
threshold and counts:

- **mixed**: a cluster holding two mistakes. It must be 0, because the result
  would be a learning nobody taught.
- **absorbed**: a one-off swept into a cluster big enough to qualify. It must
  be 0.
- **recovered**: mistakes with three findings in one cluster.

On bge-m3 (2026-10-20):

| t    | pair recall | mixed | absorbed | recovered |
| ---- | ----------- | ----- | -------- | --------- |
| 0.64 | 56 %        | 3     | 2        | 5/8       |
| 0.66 | 42 %        | 2     | 1        | 4/8       |
| 0.68 | 33 %        | 0     | 0        | 3/8       |
| 0.70 | 31 %        | 0     | 0        | 3/8       |
| 0.74 | 15 %        | 0     | 0        | 2/8       |
| 0.78 | 0 %         | 0     | 0        | 0/8       |

0.68 is the edge: one step lower mixes two clusters. The default is **0.70**,
which keeps one grid step of margin at the same recovery. Paraphrases of one
mistake on different pages sit lower in bge-m3 than intuition suggests: at
0.80, nothing clusters at all. A missed cluster only waits for more dismissals,
while a mixed one drafts a wrong learning, so the margin goes on the safe side.
Re-run the calibration when the embedding model changes.

## Repository guidance as skills

After a successful sync of a codebase or Markdown/Git connector,
`RepoGuidanceListener` (API, `ConnectorsModule`) imports the files in
`GUIDANCE_FILE_PATTERNS`, at the repository root and at the connector's
`subdir`: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
`.github/copilot-instructions.md` and `.cursor/rules/*.mdc`. **Import now**
(`POST /v1/connectors/:id/guidance/import`) runs it by hand.

These are fetched bytes, so they cross the trust boundary as untrusted:

- An imported skill starts **disabled with no trigger words**. An admin enabling
  it is the promotion to trusted text.
- While disabled it follows upstream. Once enabled, a new upstream version goes
  to `pending_instructions` and the live text does not change until
  **Accept upstream** (`POST /v1/ai/skills/:id/accept-upstream`, 409 when nothing
  is pending). An upstream commit must never silently change trusted prompt text.
- A file deleted upstream disables its skill and stamps `source_removed_at`.
  The skill is not deleted, and if the file comes back it stays disabled.
- Caps: a file over 64 KB is skipped but still counts as present, so it removes
  nothing. At most 20 files are read. Text over 8 000 characters is cut at a line
  break, and the description says so.

The service downloads its own archive through `downloadRepoArchive` rather than
loading `RepoSnapshotService` into the API, which costs one more archive download
per sync. Imports of one connector run one at a time per process. Like
triggers, the import hears a bus that does not redeliver, so a sync that
finishes while the API is down is picked up by the next sync or by **Import now**.

## Routes

| Route                                               | Access                    | Notes                                           |
| --------------------------------------------------- | ------------------------- | ----------------------------------------------- |
| `GET /v1/ai/agents/triggers`                        | admin, query              | Secrets masked; `listening` reports the switch  |
| `POST /v1/ai/agents/:key/triggers`                  | admin, body               | Created disabled                                |
| `PATCH /v1/ai/agents/triggers/:id`                  | admin, `agent-trigger`    | Enabling makes the caller the owner             |
| `DELETE /v1/ai/agents/triggers/:id`                 | admin, `agent-trigger`    |                                                 |
| `POST /v1/ai/agents/triggers/:id/rotate-secret`     | admin, `agent-trigger`    | Returns the secret once                         |
| `POST /v1/ai/agents/triggers/:id/webhook`           | `@Public()` + HMAC        | 202 with `runId` or `skipped`                   |
| `POST /v1/ai/agents/recipes/:recipe/apply`          | admin, body               | Disabled and ownerless                          |
| `GET /v1/ai/agents/learnings`                       | viewer, query             | Evidence filtered by the caller's scope         |
| `POST /v1/ai/agents/learnings`                      | editor, body              | `status: "active"` re-checks admin              |
| `PATCH /v1/ai/agents/learnings/:id`                 | admin, `agent-learning`   | Approve, reword, archive; `keepActive` (#305)   |
| `POST /v1/ai/agents/runs/:id/findings/:index/dismiss` | editor, query           | Optional learning text                          |
| `POST /v1/connectors/:id/guidance/import`           | admin, `connector`        |                                                 |
| `POST /v1/ai/skills/:id/accept-upstream`            | admin, `ai-skill`         | 409 when nothing is pending                     |
| `GET /v1/ai/agents/choices?scope=all`               | viewer, query             | Every agent's name; default `offered` unchanged |
| `POST /v1/ai/agents/:key/run`                       | editor, body              | Gains `documentIds`                             |
| `PATCH /v1/ai/agents/:key`                          | admin, body               | Gains `scheduleKind/Time/Weekdays/Timezone`     |

MCP gains `knowledge_list_agent_learnings` (viewer, active by default, open to
read-only keys) and `knowledge_propose_agent_learning` (editor, in
`WRITE_TOOLS`). There are still no trigger or run tools over MCP, for the reason
[20-agents-todo item 3](20-agents-todo.md#closed) gives.

## Settings

Every one has a default, and the new behaviour is off or inert until asked for.

| Variable                          | Default | Meaning                                                             |
| --------------------------------- | ------- | ------------------------------------------------------------------- |
| `AGENT_TRIGGERS_ENABLED`          | `false` | Kill switch for the listener, the webhook route and mention runs    |
| `AGENT_TRIGGER_MAX_ACTIVE`        | `5`     | Triggered runs one workspace may have in flight                     |
| `AGENT_TRIGGER_COOLDOWN_MINUTES`  | `60`    | Cooldown a new trigger starts with                                  |
| `AGENT_WEBHOOK_MAX_BYTES`         | `65536` | Largest delivery accepted                                           |
| `AGENT_WEBHOOK_TOLERANCE_SECONDS` | `300`   | Allowed clock difference on a delivery's timestamp                  |
| `AGENT_LEARNINGS_MAX`             | `20`    | Active learnings per prompt; `0` turns them off                     |
| `REPO_GUIDANCE_IMPORT_ENABLED`    | `true`  | After-sync import; **Import now** works either way                  |
| `LEARNER_ENABLED`                 | `false` | The learner process works at all (#305); off, it idles              |
| `LEARNER_TICK_MS`                 | `900000` | How often it wakes; each workspace is passed over once a day        |
| `LEARNER_WINDOW_DAYS`             | `30`    | How far back dismissals are read                                    |
| `LEARNER_CLUSTER_THRESHOLD`       | `0.7`   | Raw cosine to join a cluster, and to fold a draft into a learning   |
| `LEARNER_MIN_DISMISSALS`          | `3`     | Findings a cluster needs                                            |
| `LEARNER_MIN_PEOPLE`              | `2`     | Distinct dismissers a cluster needs                                 |
| `LEARNER_MIN_RUNS`                | `20`    | Runs on each side of an activation before the check says anything   |

Migrations, all additive and all run cleanly by the previous image:
`20261021100000_agent_schedule_time_of_day`, `20261022100000_agent_triggers`,
`20261023100000_agent_trigger_webhooks`, `20261024100000_agent_learnings`,
`20261025100000_ai_skill_repo_source`, and for #305 `20261123100000_derived_learnings`
(`evidence`, `archive_proposed_at`, `archive_check` on `agent_learnings`). The CHANGELOG's Operations section says
what each one does on rollback.

## Web

Everything is under **Settings → AI**:

- **Agents**: the schedule editor (Interval | Daily | Weekly as one segmented
  control, with a next-run line), `AgentTriggersEditor.vue` inside the agent
  dialog, and a **Recipes** button opening `AgentRecipesDialog.vue`.
- **Runs**: an event badge for what started a run, **Dismiss** with *Remember
  why*, and a switch to show dismissed findings.
- **Learnings**: `AgentLearningsPanel.vue`, with proposed, active and archived
  learnings and their provenance. `TeachAgentDialog.vue` is shared with the
  **Teach agent** action on an agent's reply in a page or review thread.
- **Skills**: the provenance line, **Upstream changed** with a diff dialog,
  and a **Removed upstream** badge. The connector page has an **Agent guidance**
  card.

`useAgentNames` reads `choices?scope=all`, so a learning for the curator or a
mention reply from a background agent shows the agent's name, not its key.
Destructive actions that cannot be undone from the same screen (delete a
trigger, rotate an existing secret, delete a custom agent or a skill) ask first
through `AlertDialog`.

## Known gaps

- **Deleting a custom agent orphans its triggers.** `agent_triggers` is keyed by
  agent key with no FK, by house rule. The orphans fire nothing, since guard 4
  finds no agent, but they stay in the table. Tracked as
  [20-agents-todo item G](20-agents-todo.md#g-deleting-a-custom-agent-leaves-its-triggers--s).
- **A concurrent double recipe apply** can create two disabled triggers. The
  dialog disables its buttons while a request is pending.
- **A triggered run's cost is as invisible as a scheduled one's**
  ([20-agents-todo item F](20-agents-todo.md#f-nothing-shows-a-scheduled-runs-cost--m)),
  and triggers make that more pressing.
- Learnings are person-authored or derived from dismissed findings (#305).
  Extracting them from threads automatically is deferred.
- A derived learning is scoped to one project, and a workspace-wide run (no
  pages, no connector) is given no project-scoped learning. An admin can widen
  the scope to every project when approving it.

## Specs

`apps/api/test/agent-schedule.spec.ts` (contracts' `nextScheduledRun`, including
DST in both directions), `agent-trigger.service.spec.ts`,
`agent-webhook-mention.spec.ts`, `agent-recipes.spec.ts`,
`agent-learnings.spec.ts` (learnings, the rendered prompt, dismiss),
`repo-guidance.service.spec.ts`, `learner.spec.ts` (thresholds, fold, budget
split, back-pressure, lifecycle) and `learner.e2e-spec.ts` (the derivation and
before/after queries in Postgres, a restricted page excluded). There is
no contracts-level test runner, so contracts functions are tested from
`apps/api/test`.
