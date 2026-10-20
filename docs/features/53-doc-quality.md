# 53 — Doc quality: styleguide lint, the lint gate and quality scores

Issue [#74](https://github.com/hrustalq/knowledge/issues/74), shipped as seven
PRs (#267–#272 and the one carrying this document). Before it, the reviewer
agent could say a draft had a factual gap, but nothing could say a draft broke
the house style a team had agreed on, and nobody could say whether the
knowledge base was getting better or worse.

Now a team writes its style rules down once, every merge request is checked
against them, a workspace can refuse a merge until the errors are fixed, and
every page carries a score with a history. The glossarist's proposals go into
the glossary in one click.

## What

- **A styleguide.** A list of plain-English rules, each with a severity
  (`error`, `warning`, `suggestion`), per workspace and optionally per
  project. It is an `ai_skills` row with `kind = 'styleguide'`. Admins write
  it under **Settings → AI → Styleguide**; every member can read it.
- **A lint.** The `linter` agent checks text against the styleguide of its
  project. On demand: `POST /v1/assistant/lint`, the panel's **Try it** box and
  the MCP tool `knowledge_lint_draft`. On every push to an open merge request
  whose lint policy is not `off`: a check per source head, published as one
  resolvable AI thread per violation, anchored to the quoted passage.
- **A lint gate.** Under the `block` policy a merge request waits for the check
  of its current head and is refused while an error-severity violation is
  unresolved. An admin can override one head with a reason.
- **Quality scores.** The `auditor` agent scores every page from 0 to 100 on
  six dimensions and keeps every audit. Knowledge health gets a **Quality**
  tab, a scored page a **Quality** rail widget, a project page a summary
  widget, and agents `knowledge_get_page_quality`.
- **Glossary from content.** The glossarist reads the pages it has not read at
  their current version, puts the drafted term on each finding, and **Add to
  glossary** creates the entry without a model call.

## The rules

**Which styleguide applies.** `AiSkillsService.effectiveStyleguide(workspaceId,
projectId)` is the one resolver: the project's styleguide if it has one, else
the workspace's (`project_id IS NULL`). A project row **replaces** the
workspace row and is never merged with it. A styleguide with no enabled rule is
no styleguide, and nothing calls a model for it.

**What a violation must be.** `readLintViolations` (`agents/lint.ts`) is the
gate on every lint the model answers, wherever it runs:

- its `ruleId` must be a rule of the styleguide, or it is dropped;
- its `quote` must occur verbatim in the linted text, or it is dropped;
- its severity is the rule's, never the model's;
- at most `LINT_MAX_FINDINGS` survive.

Dropped violations are counted (`dropped` on the REST response, a run warning
on a check), not shown.

**What a merge request check reads.** Only the lines the merge request adds:
`changedText` keeps the added lines of the merge-base diff, consecutive ones
together. A line that only lost something, and a passage the merge request did
not touch, are not linted, so a violation already on the target branch is not
the author's. A page's first merge request has no target head, and then all of
it is new. `styleFindings` then grounds each quote again in the whole source
head (the linted text joins separate runs, and a quote across a join exists in
neither) and anchors it as a `text` anchor with 32 characters of context. A
quote the page holds more than once is anchored to the copy whose surroundings
the linted text also holds: the passage the merge request added, not an
untouched one above it.

**When a check runs.** `LintTriggerSweeper` (API, 30 s tick) picks open,
non-draft merge requests whose source head has no check, where the effective
policy is not `off`:

- `(merge_request_id, kind, head_revision_id)` is unique, and the insert is
  the claim, so a head is linted once;
- a newer head marks a still-waiting check `skipped` (`superseded`) and
  cancels its run;
- a workspace holds at most `LINT_MAX_PENDING_PER_WORKSPACE` waiting checks;
  past that a head waits for a later tick;
- the run is the merge request author's, so their role caps it and their
  budget pays for it, checked at enqueue and again in the processor.

A check that does not run says why, from the closed `MR_CHECK_REASONS`:
`superseded`, `no-styleguide`, `restricted`, `author-unavailable`, `budget`,
`run-failed`, `stale`.

**How a check is published.** `LintPublishSweeper` (API, 15 s tick) claims a
finished check by stamping `published_at` in one guarded statement, then
reconciles with the lint threads earlier checks opened (`planLintThreads`):

- a violation that already has a thread keeps it, open or resolved (a person
  who resolved it has answered it);
- a new violation gets a thread, written as the author with
  `agent_key = 'linter'`, `check_id` and `rule_id` set;
- an open thread whose violation is gone is resolved.

A violation is identified by rule and quote. The same rule with a quote that
contains the other, or is contained by it, is the same violation, because a
model asked twice quotes one sentence a little wider or narrower. Only lint
threads are ever passed in, so a person's thread is never touched. Bodies are
escaped and `@`-defused (`lintThreadBody`, the drift report's rule). A run
that finished more than 24 hours ago is `stale` and not published. No
notification is sent.

**What the gate holds.** `lintGate()` (`documents/lint/lint-check.ts`) is the
one predicate the merge gate and the merge widget read:

| Check of the current source head | `warn` | `block` |
| --- | --- | --- |
| missing, `pending`, `running` | merges | 409 `lint` |
| `failed` with an unresolved thread whose rule the run marked `error` | merges | 409 `lint` |
| `failed` with only warnings, suggestions or resolved errors | merges | merges |
| `passed` | merges | merges |
| overridden by an admin | merges | merges |
| `error`, `skipped` | merges | merges |

The severity a thread is held to is the one its rule had **when the run read
the styleguide** (`errorRuleIds` over the run's findings), so editing a rule
afterwards does not change what that head was held to. The gate is not
enforced for the `AUTH_MODE=none` dev principal or a principal-less MCP
client (`lintGateEnforced`), the approval gate's trust semantics.

**Which policy applies.** `resolveLintPolicy` folds four inputs: the
project's `projects.lint_policy`, the workspace's
`workspace_settings.lint_policy`, the deployment's `STYLE_LINT_POLICY`
ceiling, and whether the `linter` agent is enabled. A project inherits its
workspace, a workspace the ceiling. Whatever is asked for is clamped to the
ceiling (`off` < `warn` < `block`), and a disabled `linter` turns it `off`. The
result carries `requested`, `inherited`, `effective` and `source`, so the
panel shows what was asked for beside what applies.

**How a page is scored.** `agents/quality.ts`, Nest-free:

| Dimension | Measured by | Weight |
| --- | --- | --- |
| `clarity` | the model, 0–100 | 0.25 |
| `completeness` | the model, 0–100 | 0.25 |
| `style` | the model, gated by `readLintViolations`; 100 less 25 / 10 / 3 per error / warning / suggestion | 0.15 |
| `links` | share of internal links that resolve | 0.15 |
| `ownership` | 100 with an owner (feature 39), else 0 | 0.10 |
| `duplication` | 100 less 60 per near-duplicate peer | 0.10 |

`overall` is the weighted mean of the dimensions that were measured; one that
was not (`null`) drops out and the rest are renormalised. Style is `null` with
no styleguide, clarity and completeness with no model, duplication on the stub
embeddings provider. An empty page scores 0 without a model call.

- **Links.** `extractPageLinks` and the reader's resolver, lifted from the web
  into `@knowledge/contracts/content`, decide. An id link is broken when no
  live page of the workspace has that id: a missing one, one in another
  workspace, or an archived one (archiving is how a page is deleted). A title
  reference is broken when the
  reader would leave it as brackets: no page by that title, or several and
  none in the page's own project. Links resolve against every page in the
  workspace, so a link to a restricted page is not broken.
- **Duplicates.** `GraphService.meanRevisionEmbeddings` returns each head's
  mean chunk embedding, and `duplicatePeers` pairs pages whose cosine reaches
  `QUALITY_DUPLICATE_THRESHOLD`, each pair once.

**When a page is scored again.** `isDue`: never scored, scored at another
revision, under an older `RUBRIC_VERSION`, against another styleguide
(`styleguide_hash`), longer ago than the audit interval, or scored without a
judgement while a model is available now. When the stored row judged this
revision against these rules, `reusableModelHalf` reuses clarity, completeness
and style, and only the facts are recomputed. A run over an unchanged
workspace makes no model call.

## Decisions

**The styleguide is a skill row, not a table.** `ai_skills` was already the
trusted-instruction channel, loaded in the worker, with admin CRUD, an ACL
source (`ai-skill`) and a panel. It gained `kind`, `project_id` and `rules`
(Json). Every skill query now filters `kind = 'skill'`, so a styleguide never
appears among skills and never joins a chat turn by trigger word, and an empty
styleguide table leaves every prompt byte-identical. One styleguide per scope
is a raw partial unique index (`ai_skills_one_styleguide_per_scope`), which
Prisma cannot express. A styleguide's `name` shares `@@unique([workspaceId,
name])` with skills, so a clash is a 409. If rules ever need their own
lifecycle (per-rule history, per-project enable), they move to a `style_rules`
table.

**A project replaces, it does not merge.** Merging would make it impossible to
relax a workspace rule for one project without per-rule tombstones.

**The gate policy is a merge-gate setting.** It lives in
`workspace_settings.lint_policy` beside `api_breaking_change_policy`
([52](52-api-reference.md)), with the same `off | warn | block` vocabulary,
not in `ai_settings`, which stays AI behaviour. The audit interval is AI
behaviour, so it is `ai_settings.quality_audit_days`. The issue's
`advisory` / `blocking` became `warn` / `block`.

**Fail-open.** A check that could not run (`error`) or did not (`skipped`)
never holds a merge. A provider outage or a spent budget must not freeze every
merge in a workspace. A disabled `linter` makes the policy `off` rather than
reporting a separate `disabled` gate state.

**A sweeper, not a hook in revision writes.** It covers merge requests opened
by people, agents, MCP clients, workflows and connectors alike, and a head
pushed while the API was down is linted when it comes back. No event-bus
trigger was added, so feature 17's re-trigger guards were not needed.

**The worker lints, the API publishes.** `linter` is not in
`RUNNABLE_AGENTS` (the sentinel's reasoning): it runs only for a check. The
run stores `style` findings; `LintPublishSweeper` turns them into threads.
`AGENT_RUN_TRIGGERS` gained `'merge-request'`, emitted only by
`LintTriggerSweeper`.

**A restricted page is not linted.** Agent runs and their findings are listed
to every member, so the lint reads under `audienceScope(…,
WORKSPACE_AUDIENCE)` at enqueue and again in the executor, like the other
background agents. A page some members cannot read is `skipped` with
`restricted`.

**Checks are their own route.** `GET /v1/merge-requests/:id/checks`, following
the `api-changes` precedent, rather than a `checks` block on
`MergeRequestInfo`. `running` is derived from the run and never stored. The
response carries `gate`, computed for the caller.

**The override sits beside `breaking-ack`.** It is on
`MergeRequestsController` because it needs `AuditService` and the activity
recorder, and `LintChecksService` must stay worker-safe. It is admin-only,
needs a reason (≤ 500 characters), binds to the current head only, and is
written to `audit_logs` (`merge-request.lint-override`) and the merge
request's activity (`merge-request.updated`, `changed: ['lintOverride']`).
**Check again** on an overridden head drops the override with the old check.

**Gate order.** `draft`, `approvals`, the protected-branch admin check, then
`lint`, then `diverged`, then `breaking-api`. Lint runs before divergence
because a rebase only produces a new head to lint.

**Score rows, not an aggregate.** `document_quality_scores` is append-only: a
row is a fact about one revision at one time, and history is the rows.
Dashboards read the newest row per page with `DISTINCT ON (document_id)` and
compute counts and means on read. There is no backfill: a page reads "not
audited yet" until the first run, which is acceptable because a score is a
measurement, not a denormalized copy of an existing fact.

**The worker writes the score rows.** This is an exception in kind to "the
worker generates, the API publishes". A score is a generated measurement, like
`agent_runs.findings`: it creates no page, opens no merge request and
attributes no act to a person.

**The auditor judges style itself.** The styleguide is in its prompt, and the
linter's `readLintViolations` gates what comes back. MR lint checks are not
reused: they lint merge request source heads, which never become the default
branch head after a squash.

**Duplicates are compared in Node.** `meanRevisionEmbeddings` plus the
Nest-free `duplicatePeers`, instead of the planned
`GraphService.documentNeighbours`, so the pairing is testable without
ArcadeDB. Pairwise cosine is O(n²). `searchChunks` moved to an ArcadeDB
vector index in #304, and this comparison did not: it ranks means the run
already holds. `meanRevisionEmbeddings` now averages every chunk of a page
instead of stopping at 5,000 per batch. On `EMBEDDINGS_PROVIDER=stub` duplication is `null` and
the run says so, because the stub's similarity measures shared words, not
shared meaning (the surveyor's rule).

**The dashboard is a tab, not a page.** Quality is the third tab of
`/knowledge-health` ([40](40-knowledge-health.md)), not `/settings/quality`.
It follows `KnowledgeHealthPage`: vue-query keyed on the active project, so
there is no `stores/quality.ts` and nothing to `rescope()`. A score is ink;
below `lowThreshold` (= `QUALITY_FINDING_THRESHOLD`) it takes
`--kn-panel-caution`, DESIGN.md's reserved-signal rule.

**Every figure is under the reader's scope.** The `pages` CTE behind every
quality query keeps listed, unarchived `kind = 'page'` rows under
`visibilitySql`. A near-duplicate peer the reader cannot open is dropped,
together with the issue that names it.

**The lint lives outside `AssistantService`.** MCP cannot load
`AssistantModule`, so the lint is `StyleLintService` in `StyleLintModule`, the
one implementation behind `POST /v1/assistant/lint` and
`knowledge_lint_draft`.

**The glossarist's watermark is derived.** Each run records the heads it read
in `agent_runs.details.glossaryScanned`; the next run skips a page whose head
is in any earlier succeeded run's list. `details`, not `input`, because
`input` is written before the run reads anything. No migration. A page named
on the run is always read, and a page `suggest` failed on is not recorded, so
it is read again. Each run still reads at most 15 pages, most recently active
first.

**Add to glossary is a claim.** `POST
/v1/ai/agents/runs/:id/findings/:index/add-term` writes through
`GlossaryService.create` with `source: 'ai'`, as the caller, guarded by the
same claim/release pair as Propose. The body may edit the term, aliases and
definition; the project is always the finding's. A second press is a 409
`already-added`; a name clash returns the glossary's own 409 and releases the
claim. `GlossaryPage`'s form was not extracted: it is bound to the
defining-page picker, the matching rules and the rich editor, which the route
does not take.

## Surface

| What | Where |
| --- | --- |
| Tables | `ai_skills.kind` / `project_id` / `rules`, `merge_request_checks`, `merge_request_threads.check_id` / `rule_id`, `workspace_settings.lint_policy`, `projects.lint_policy`, `document_quality_scores`, `ai_settings.quality_audit_days` |
| Vocabulary | `@knowledge/contracts/ai` (`AI_SKILL_KINDS`, `StyleRule`, `'linter'` / `'auditor'`, `'lint'` / `'audit'` usage, `'style'` / `'quality'` findings, `AgentFinding.ruleId` / `anchor` / `term` / `termId`), `…/reviews` (`MR_CHECK_KINDS`, `MR_CHECK_STATUSES`, `MR_CHECK_REASONS`, `LINT_POLICIES`, `LintGateState`, `reason: 'lint'`), `…/quality` (`QUALITY_DIMENSIONS`, `QUALITY_BANDS`, response types), `…/content` (`extractPageLinks`, `pageRefKey`, `buildPageRefResolver`) |
| Lint, pure | `agents/lint.ts` (`lintMessages`, `readLintViolations`, `renderStyleguide`), `documents/lint/lint-check.ts` (`resolveLintPolicy`, `changedText`, `styleFindings`, `planLintThreads`, `lintGate`) |
| Lint, services | `StyleLintService` (`StyleLintModule`), `LintChecksService` (`LintCoreModule`, both processes), `LintTriggerSweeper` / `LintPublishSweeper` / `LintController` (`LintModule`, API-only) |
| Gate and override | `MergeRequestsService.merge`, `overrideLintCheck` |
| Scoring | `agents/quality.ts`, `AgentExecutor.audit`, `GraphService.meanRevisionEmbeddings` |
| Reading scores | `QualityService` (`QualityCoreModule`, imported by MCP), `QualityController` (`QualityModule`) |
| Glossary | `AgentExecutor.buildGlossary` / `glossaryScanned`, `AgentFindingsService.addTerm` |

| Route | Access |
| --- | --- |
| `GET /v1/ai/styleguides?workspaceId=&projectId=` | viewer, query |
| `PUT /v1/ai/styleguides` | admin, body |
| `DELETE /v1/ai/styleguides/:id` | admin, ai-skill |
| `POST /v1/assistant/lint` | viewer, body; budget-checked |
| `GET` / `PUT /v1/lint-policy` | viewer, query / admin, body |
| `GET /v1/merge-requests/:id/checks` | viewer, merge request; `gate` for the caller |
| `POST /v1/merge-requests/:id/checks/lint` | editor, merge request; re-lints the head |
| `POST /v1/merge-requests/:id/checks/:checkId/override` | admin, merge request; `{ reason }` |
| `POST /v1/merge-requests/:id/merge` | unchanged access; gains 409 `lint` (`checkStatus`, `blockingCount`, `checkId`) |
| `GET /v1/quality/summary?workspaceId=&projectId=` | viewer, query |
| `GET /v1/quality/documents?workspaceId=&projectId=` | viewer, query; worst first |
| `GET /v1/documents/:id/quality` | viewer, document |
| `GET` / `PATCH /v1/ai/settings` | unchanged; gains `qualityAudit` / `qualityAuditDays` |
| `POST /v1/ai/agents/runs/:id/findings/:index/add-term` | editor, query |

| MCP tool | Guard |
| --- | --- |
| `knowledge_lint_draft` | viewer; read tool; same payload as `POST /v1/assistant/lint` |
| `knowledge_get_page_quality` | viewer; read tool; same payload as `GET /v1/documents/:id/quality` |

Neither is in `WRITE_TOOLS`. `knowledge_lint_draft` still spends model budget
and checks it. Both have a section in the generated SKILL.md.

Web:

- `components/ai/AiStyleguidePanel.vue` (scope picker, rules with severity,
  examples and up/down reorder, **Try it**, the lint policy for the scope with
  requested beside effective);
- in `components/merge-requests/`: `MergeWidget.vue` (the style row: waiting,
  running, passed, blocking N, overridden, did not run; **Check again**; the
  override dialog; the `lint` 409), `ThreadCard.vue` (rule chip, "on behalf
  of {author}"), `AiCheckPane.vue` (a Style section with the current head's
  check);
- `components/quality/` (`QualityPanel`, `QualityRail` at `?tab=quality`, the
  project overview widget, `QualityMeter`, `QualityHistoryChart`,
  `QualityDistribution`), each widget shown only when there are scores;
- the audit interval under AI settings → Config;
- in `AgentRunsPanel.vue`, **Add to glossary** in place of Propose on a term
  finding, then **View in glossary** (`/settings/glossary?term=<id>`).

## Operations

- Migrations `20261106100000_styleguide`, `20261107100000_merge_request_checks`
  and `20261108100000_document_quality_scores`. The last two are additive and
  the previous image reads none of their columns, so a rollback is safe. The
  first is not quite: the previous image does not know `kind` and would list a
  styleguide as an empty skill. Delete styleguides before rolling back:
  `DELETE FROM ai_skills WHERE kind = 'styleguide'`.
- New env vars, all with defaults, and nothing runs until someone asks:
  `STYLE_LINT_POLICY` (`off`; the ceiling and the policy of every scope that
  sets none), `LINT_MAX_FINDINGS` (15), `LINT_MAX_PENDING_PER_WORKSPACE` (20),
  `STYLEGUIDE_MAX_RULES` (50), `QUALITY_AUDIT_MAX_PAGES` (200),
  `QUALITY_AUDIT_DAYS` (7), `QUALITY_DUPLICATE_THRESHOLD` (0.92) and
  `QUALITY_FINDING_THRESHOLD` (50).
- Raising `STYLE_LINT_POLICY` to `block` makes `block` the policy of every
  workspace and project that sets none, so merges there wait for their check.
  Each check is one model call per push, billed to the merge request's author.
- On `EMBEDDINGS_PROVIDER=stub` the auditor's duplication dimension is
  `null`. Production has run bge-m3 since 2026-10-18 (#257), so it is measured
  there.

## Deliberate deferrals

- An editor **Check style** action with violations drawn as decorations. The
  route exists (`POST /v1/assistant/lint`); only the styleguide panel's **Try
  it** box calls it from the web.
- The styleguide in the `author` / `drafter` prompts (`styleguideInDrafts`).
- The opt-in HEAD probe of external links (`QUALITY_EXTERNAL_LINKS`).
- A `checks` block on `knowledge_get_merge_request` and on `MergeRequestInfo`;
  `GET …/checks` is the one reader.
- A fail-closed option, and debouncing a check until a head is a few seconds
  old.
- Per-severity caps, or folding suggestions into one plain comment, if fifteen
  threads on a small merge request read as a wall.
- Deterministic prose linters (Vale and the like), auto-fixing a violation,
  linting GitHub / GitLab pull requests (that is the sentinel's,
  [35](35-pr-drift-check.md)), and ranking search by score.

## Verification

- Specs: `lint.spec.ts` (grounding, unknown rule dropped, severity from the
  rule, untrusted wrapping, scope fallback, prompts byte-identical with no
  styleguide), `lint-check.spec.ts` (one check per head, a newer head
  superseding, published once, stale threads resolved, people's threads
  untouched, the 24 h cutoff, the author billed, the anchor on the added
  copy of a repeated quote, and the gate matrix of
  policy × check status × override with resolve-to-unblock),
  `quality.spec.ts` (links, duplicate pairing, weighting with null
  dimensions, the model half reused, ownership), `glossary-findings.spec.ts`
  (8 cases: the term, its project, twice → 409, already-read heads skipped, a
  failed page not recorded, the glossary's 409 releasing the claim).
  `quality.e2e-spec.ts` needs live infra and is not in CI; it passed locally
  5/5 under `AUTH_MODE=api-key` with a non-admin editor and an admin (counts,
  bands, history, worst order, a restricted page and its hidden peer,
  cross-workspace 403, MCP matching REST). `styleguides.e2e-spec.ts` likewise
  (3/3): the project override for its project and the workspace styleguide
  for any other, non-admin `PUT`/`DELETE` → 403, never listed as a skill.
- Live on dev: a merge request linted by a real model through the dev
  worker, its threads resolved and kept across pushes; the `block` gate, its
  409 and an override; the Quality tab, rail and project widget against
  seeded rows in dark desktop, light 390 px and 1100 px with the sidebar
  open; **Add to glossary** against a seeded run (prefilled dialog, an edited
  definition saved as an `ai` term, the link landing on the entry, a second
  press 409).
- Not checked live: an `auditor` run with a model against the dev worker
  (scores were seeded), a glossarist run with a model (the demo provider is
  `none`), and the Russian layouts.
