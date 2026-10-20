# 55 — Learning loop: outcome ledger, derived learnings, offline tuner

Issue [#305](https://github.com/hrustalq/knowledge/issues/305), shipped as
five PRs: the ledger (#376), the learner and the `coach` (#386), MCP delivery
(#387), the tuner (#388) and the one carrying this document. Before it, the
platform's agents could repeat a mistake indefinitely and nothing would
notice. Learnings ([feature 49](49-agent-triggers.md#learnings)), votes
([38](38-answer-provenance.md)) and capture outcomes ([50](50-agent-memory.md))
all existed, but nothing tied an outcome to the prompt and model that produced
it, nothing counted outcomes per agent, and every learning was written by a
person.

The loop closes that gap **without training anything**:

1. **The ledger** attributes every agent run, usage row and answer vote to its
   provider, model, prompt hash and active learnings. It counts what became of
   each agent's output.
2. **The learner** clusters findings people keep dismissing and drafts
   **proposed** learnings from them through the `coach` agent.
3. **MCP delivery** sends approved learnings to coding agents connected over
   MCP, and the learner drafts MCP learnings from their failures too.
4. **The tuner** (`make tune`) replays the backtest datasets offline and
   **proposes** values for four retrieval and dedupe knobs.

This is outcome-driven, in-context reinforcement at the scale of one
deployment. It is not RL on weights: a few hundred merge requests are not
enough reward signal, and the Mac mini cannot train.

## The rules

- **A person approves every change.** The learner writes only `proposed`
  rows, and the tuner writes nothing at all. Activating a learning stays
  admin-only and API-side, and a tuned value reaches search only when a person
  sends the `PATCH` the tuner printed.
- **No ledger table.** Attribution is columns on rows that already exist
  (`agent_runs`, `ai_usage`, `answer_feedback`). An outcome is a derived
  classifier with an SQL inverse, so every count is a query over those rows.
- **Sparse override.** With `LEARNER_ENABLED=false`, every new setting `null`
  and every new env var at its default, agents, search ranking and capture
  dedupe behave exactly as before. The only difference is that the attribution
  columns are written.
- **Enforce at the point of action.** No restricted page reaches a learning.
  The learner's query enforces that, not the `coach`'s prompt.

## The ledger

**Attribution.** Migration `20261121100000_learning_ledger` adds nullable
columns. A row from before it reads as unattributed.

| Row               | Columns                                                       | Written by                                                     |
| ----------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `agent_runs`      | `provider_id`, `model`, `prompt_hash`, `learning_ids uuid[]`  | `AgentExecutor`, when the run finishes                         |
| `ai_usage`        | `agent_key`, `agent_run_id`                                   | `AiUsageService.record`, from the run context (fire-and-forget) |
| `answer_feedback` | `provider_id`, `model`                                        | `AnswerFeedbackService`, from the turn's resolved config       |

- `prompt_hash` is `promptHashOf` (`agents/agent.executor.ts`): SHA-256 over
  the agent's instructions (the built-in prompt or its override) and the
  **trusted** parts the executor rendered, meaning skills, learnings and a
  styleguide. The parts are order-free, and empty parts are dropped. Page
  content is wrapped untrusted in the user turn and never reaches the hash.
  That is what makes two runs over different pages comparable as one prompt.
- `learning_ids` are the ids `promptFor` actually rendered into that run.
  `promptFor` returns them with the text, so the stamp and the prompt cannot
  disagree.
- A vote records the model that wrote the answer. It does not record an
  agent, because answers have none. An MCP agent's own model is unknown to the
  server, and is stored as `null`.

**Outcomes.** `AGENT_OUTCOMES = ['accepted', 'dismissed', 'downvoted',
'pending']` in contracts. `outcomeFor` classifies one thing, and the API's
`outcomeCaseSql` is the same function written in SQL, clause for clause.
`agent-outcomes.e2e-spec.ts` runs the two against each other in Postgres.

| Subject          | Rule, first match wins                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| A finding        | dismissed → `dismissed`; its merge request merged → `accepted`, closed → `dismissed`, open → `pending`; no MR and the run finished over `AGENT_OUTCOME_SETTLE_DAYS` (14) ago → `accepted`; else `pending` |
| An answer's vote | up → `accepted`; down → `downvoted`                                                                            |

There is no `edited` outcome (merged after a person changed it). Nothing
computes edits before a merge yet, and a closed vocabulary must not promise a
value the code never emits.

**Route.** `GET /v1/agent-outcomes?workspaceId&agentKey&projectId&since&split`
is `@Access('admin', 'query')`. It returns counts per agent × outcome, with
answers as their own group. `split=prompt|model` breaks each agent down by
prompt hash or model. `since` defaults to 90 days back. The response carries
`settleDays` and `minRuns`, so the client keeps no copy of either.

**Agents tab.** `/knowledge-health?tab=agents`, `AgentOutcomesPanel`, is
admin-only like its route ([feature 40](40-knowledge-health.md#on-the-dashboard)).
Below `AGENT_OUTCOME_MIN_RUNS` (20) runs a cell shows a count ("4 of 9"),
never a rate. "44 % dismissed" over nine runs would be a guess.

## Derived learnings

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

### Learnings for MCP agents

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

## The tuner

### The knobs

Four constants that were set by hand are now sparse per-workspace overrides.
`null` inherits the default, and an empty override ranks and dedupes exactly
as before.

| Knob                     | Stored on                                                | Default                                    | Read by                                   |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `rrfK`                   | `knowledge_health_settings.rrf_k`                        | `SEARCH_RRF_K` (60, contracts)             | `fuseHits` in `SearchService`             |
| `trustWeights`           | `knowledge_health_settings.trust_weights` (jsonb)        | `TRUST_WEIGHTS` (contracts)                | the trust re-rank, through `trustWeight`  |
| `captureDedupeThreshold` | `ai_settings.capture_dedupe_threshold` (since #73/#234)  | `CAPTURE_DEDUPE_THRESHOLD` (0.92)          | capture dedupe                            |
| `captureAmendThreshold`  | `ai_settings.capture_amend_threshold` (since #73/#234)   | `CAPTURE_AMEND_THRESHOLD` (0.8)            | capture amend, never above dedupe         |

The issue planned all four on `workspace_settings`. That changed in two ways:

- **The search knobs live on `knowledge_health_settings`.** Search already
  reads that row on every query for `trustRanking`, so the knobs cost no
  extra query. `VerificationPolicyService` already returns `effective`,
  `override` and `defaults`, which is the asked-for vs applied contract the
  settings UI needs.
- **The capture thresholds got no new columns.** They were already sparse
  overrides with an asked/applied panel (`AiCapturePanel`). The tuner proposes
  `PATCH /v1/ai/settings` bodies for them.

`trustWeights` is sparse **per state**. Overriding `outdated` leaves the other
seven states at their defaults, because `effective` is
`{ ...TRUST_WEIGHTS, ...override }`. `PATCH /v1/knowledge-health/settings`
validates each weight against `TRUST_WEIGHT_MIN`/`MAX` (0.1–1.25) and strips
unknown keys. `trustWeights: null` resets the column to SQL NULL, not to a
JSON `null`. `rrfK` is an integer from 1 to 1000. These knobs default to code
constants, not env vars, so there is no env ceiling to clamp them. The web form
still shows what is asked for, what applies and the default for each.

When trust ranking is off, the weights cannot move a result. The settings
panel says so, and so does the tuner's report.

### `make tune`

`make tune ARGS="--workspace <id>"` is `backtest.main.ts --tune`, not a
separate script. It reuses the backtest's datasets, readers and capture
probes. `captureScores` is shared with `--captures`. The tuner **only
reads**:

- **Objective: MRR** on the workspace's votes. They are read from Postgres
  through `FeedbackDatasetService`, or from `--feedback <file>` (an
  `--export-feedback` file).
- **Constraint: known-item recall@5** over up to `--limit` (120) listed page
  titles may drop by at most one point (`MAX_RECALL_DROP`).
- **Holdout.** 30 % of each set (`HOLDOUT_SHARE`) is held out by a stable
  FNV hash of the query, or of the page id for capture probes, so a re-run
  splits the same way. Both the objective and the constraint are tuned on
  the train split and must hold on the holdout too. Otherwise nothing is
  proposed, and the report says why.

**One search per query.** `SearchService.search` takes an optional observer
that receives a `SearchPool`: both legs at `fetchK` and the state of every page
either leg named. `rankPool` (`search/ranking.ts`) re-fuses and re-weights that
pool in memory with the same `fuseHits` the service uses. A parity case in
`search-trust.spec.ts` replays one search through both under three knob sets.
ArcadeDB sees one search per query, not one per candidate, and a full grid
costs seconds. The backtest's OOM note still applies: run one at a time.

**Search descent** (`search/tuning.ts`). Coordinate descent over `rrfK`
(`RRF_K_GRID`: 10 … 200) and the weights of `verified`, `expired`, `flagged`,
`outdated` and `inactive` (`WEIGHT_GRID`: 0.30 … 1.25 in 0.05 steps).
`unverified`, `requested` and `edited` stay the reference 1, because scaling
every weight ranks nothing differently. Each axis takes the best grid value,
and only a strict improvement moves it, so a flat objective leaves the current
knobs alone. Values are tried nearest first, so of equally good moves the
smallest wins. At most three passes.

**Capture thresholds.** `tuneThreshold` walks the calibration grid on the
capture probes and keeps the #234 precision floor. A threshold moves only if
the error sum falls on both splits **and** the costly error does not grow. For
dedupe, the costly error is a dropped new fact. For amend, it is a false amend.
The amend search is capped at the dedupe value it would run under.

**Output:**

- a console report: current vs candidate knobs, train and holdout metrics for
  both sets, threshold errors, and a verdict with its reason;
- the `PATCH /v1/knowledge-health/settings?workspaceId=…` and
  `PATCH /v1/ai/settings` bodies to apply. `trustWeights` carries the states
  already overridden, because a PATCH replaces the stored map;
- one JSON line appended to `tune-<day>.jsonl` in the backtest log directory.

"Nothing to propose. No setting was written." is the normal answer for a
workspace with no labelled votes. As of #388, no real proposal has been
produced: the local DB has no votes, so the proposal path is covered only by
`search-tuning.spec.ts`. The first real run should be on production data.

## Routes

| Route                                       | Access                  | Notes                                                       |
| ------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `GET /v1/agent-outcomes`                    | admin, query            | Counts per agent × outcome; `split=none\|prompt\|model`     |
| `GET /v1/ai/agents/learnings`               | viewer, query           | Evidence filtered by the caller's scope                     |
| `PATCH /v1/ai/agents/learnings/:id`         | admin, `agent-learning` | Approve, archive; `keepActive: true` clears a proposed archive |
| `GET`/`PATCH /v1/knowledge-health/settings` | viewer / admin, query   | Gains `rrfK` and `trustWeights`                             |
| `PATCH /v1/ai/settings`                     | admin, body             | Unchanged; where capture-threshold proposals are applied    |

MCP gains no tool. Approved `mcp` learnings travel in the server instructions
and `knowledge://skill`.

## Settings

Every variable has a default, and the learner is inert until it is turned on.

| Variable                    | Default  | Meaning                                                                  |
| --------------------------- | -------- | ------------------------------------------------------------------------ |
| `LEARNER_ENABLED`           | `false`  | The learner process does any work; off, it boots and idles               |
| `LEARNER_TICK_MS`           | `900000` | How often it wakes; each workspace is passed over once a day at most     |
| `LEARNER_WINDOW_DAYS`       | `30`     | How far back dismissals are read                                         |
| `LEARNER_CLUSTER_THRESHOLD` | `0.7`    | Raw cosine to join a cluster and to fold a draft into a learning (bge-m3) |
| `LEARNER_MIN_DISMISSALS`    | `3`      | Findings a cluster needs                                                 |
| `LEARNER_MIN_PEOPLE`        | `2`      | Distinct dismissers a cluster needs                                      |
| `LEARNER_MIN_RUNS`          | `20`     | Runs on each side of an approval before the lifecycle check says anything |

Contract constants: `AGENT_OUTCOME_SETTLE_DAYS` (14), `AGENT_OUTCOME_MIN_RUNS`
(20), `SEARCH_RRF_K` (60), `TRUST_WEIGHTS`, `TRUST_WEIGHT_MIN`/`MAX`.

## Operations

- **Processes.** The learner is a fifth entrypoint of the API image
  (`node dist/learner.main`; [architecture 01](../architecture/01-entrypoints-modules.md)).
  It is a `learner` service in both compose files under the compose profile
  `learner`. It needs Postgres, the embedding provider and the workspace's
  model for the `coach`. It needs no Redis, opens no port and consumes no
  queue. Locally, run `make dev-learner`.
- **Turning it on in production.** Set `LEARNER_ENABLED=true` and add
  `learner` to `COMPOSE_PROFILES` in the GitHub `production` environment
  (`gh variable set --env production`). Any other `LEARNER_*` var you set
  must be in that environment first, because `deploy.yml` refuses variables
  missing there. The vars are commented out in `.env.production.example`, so
  a deploy that leaves the learner off asks for nothing new.
- **Migrations**, all additive with no backfill, and all survive a code
  rollback:
  - `20261121100000_learning_ledger`: the attribution columns;
  - `20261123100000_derived_learnings`: `agent_learnings.evidence`,
    `archive_proposed_at` and `archive_check`, plus `derived` in the
    `source_kind` CHECK;
  - `20261124100000_search_knobs`: `knowledge_health_settings.rrf_k` and
    `trust_weights`.
- **Cost.** The `coach` bills `operation = 'coach'` usage to the zeros stub.
  Findings are embedded on the fly once per pass and never stored.
- **Calibration.** Re-run `make backtest ARGS="--learner"` when the embedding
  model changes, and `make tune` after a meaningful number of new votes.

## Known gaps

- **MCP failures are not on the Agents tab.** The ledger counts agent runs
  and answer votes. A rejected capture or a closed captured MR feeds the
  learner but is not an `mcp` row in `/v1/agent-outcomes`. That would take a
  third source in `outcomeCaseSql`.
- **No `edited` outcome.** It waits until something computes edits before a
  merge.
- **A derived learning is project-scoped.** A workspace-wide run (no pages, no
  connector) is given no project-scoped learning. An admin can widen the
  scope when approving it.
- **The due check is in memory.** A restart makes every workspace due once
  more. A pass is idempotent, apart from asking the `coach` again about
  clusters it declined.
- **Published-site Ask keeps its own RRF constant.** `public-ask.service.ts`
  ranks snapshot rows with a different formula, and the tuner does not touch
  it.
- **Sparse signal.** At current volume, a cluster of three may take weeks to
  form. The thresholds are env vars so they can be lowered after calibration.

## Specs

- `agent-outcomes.e2e-spec.ts`: `outcomeFor` ↔ `outcomeCaseSql` parity in
  Postgres, the counts and splits.
- `learner.spec.ts`: thresholds (three from one person does not qualify),
  fold not insert, the budget split never displacing a manual learning,
  back-pressure, the lifecycle check.
- `learner.e2e-spec.ts`: the derivation and before/after queries in Postgres,
  a restricted page excluded.
- `mcp-http.spec.ts`: learnings in the instructions over real HTTP, a
  narrowed key seeing only its projects.
- `search-tuning.spec.ts`: an empty override ≡ the constants; a sparse merge;
  `null` → SQL NULL; a proposal emitted when the holdout agrees and suppressed
  when it regresses; none without votes; the #234 floor refusing to trade
  dropped facts for caught restatements.
- `search-trust.spec.ts`: pool ↔ `search()` parity, and the knobs coming from
  the settings.
