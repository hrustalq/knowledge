# 38 — Answer provenance: sentence citations, confidence, the verification stamp, votes, reports, and coverage gaps

Issue #67, phases 1–4 of five (the **Answer trust & feedback loop**
milestone). The last phase adds a feedback dataset for the backtest. Phase 1 is the part they all stand on — an answer that can say
which sentence rests on which page, how old that page is, who wrote it, and
whether anyone has checked it. Phase 2 is the first thing built on it: a
reader's verdict on the answer, and the harness's own verdict when nobody
gives one.

## What

- **Sentence-level citations.** Every source the assistant gathers in a turn
  gets a label — `S1`, `S2`, … — shown to the model inside each tool result
  (`cite`). The model ends factual sentences with the labels they rest on
  (`… [S2]`, `… [S1, S3]`). At the end of the turn the API settles the markers
  against the labels it actually handed out: a label nobody returned is
  stripped and counted, spacing is normalized, and each surviving marker is
  attributed to the sentence it closes. The result is stored as
  `assistant_messages.citations` (`AnswerCitation[]`: character spans into the
  message text plus the labels) and returned on `/ask` and in the `done` frame.
- **Provenance on every source.** `AssistantAskSource` gains the optional
  fields of `SourceProvenance`: `revisionId`, `revisionNumber`, `chunkId`,
  `headingPath`, `authorId`, `authorName`, `changedAt`, `verification`,
  `verifiedAt`, `verifiedByName`, `factClass`, `score`. Resolved **once per
  answer** by `ProvenanceService` in one batched PostgreSQL read, never per
  tool call. `knowledge_search` over MCP decorates its hits with the same
  fields and adds a `traceId` for the call.
- **Confidence.** `AnswerConfidence { level, score, reasons }` derived by
  `assessAnswer`, a pure function in `@knowledge/contracts`, from what the
  harness observed: citation coverage, distinct cited sources, best retrieval
  score, stale or outdated or flagged sources, inferred-only evidence, tool
  errors, and a spent tool budget. `none` is reserved for an answer with no
  sources at all. Stored as `assistant_messages.confidence`, returned on
  `/ask` and in `done`.
- **The verification stamp.** `POST /v1/documents/:id/verify` (editor) writes
  `verified_at`, `verified_by`, `verified_revision_id` at the current head;
  `DELETE` removes it. Whether the stamp still holds is **derived** on read by
  `verificationStateFor`: `verified` when the stamped revision is the head,
  `outdated` once the head has moved, `unverified` without a stamp, `flagged`
  once an open report exists (phase 3). Activity records `document.verified` /
  `document.unverified`.
- **Web.** Markers render as superscript buttons: hovering one lights the
  matching source chip and vice versa; clicking opens the page at the cited
  section. Each chip carries a verification dot and a provenance card
  (revision, author, "changed 3 months ago", verification and fact-class
  badges, the cited section, Open page). A confidence badge heads the answer's
  footer with the reasons as sentences on hover. The document page gets a
  **Verify** button that reads the derived state: stamp, remove, or re-stamp
  an outdated page. The editor assistant mounts the same `ChatPane`, so it has
  all of this with no extra work.

## Why

An answer was a paragraph and a flat row of chips. A reader could not tell
which sentence came from which page, whether that page was written last week
or two years ago, or whether anyone had ever checked it — and the product had
no way to say how sure it was beyond the model's tone. Every later phase of the
milestone needs these facts: a vote needs the confidence it is disagreeing
with, a report needs the revision the reporter read, a coverage-gap finding
needs to know which answers were weak. So they ship first, on their own.

## Decisions

**The markers stay `[S2]`, not `[2]`.** The issue proposed renumbering to a
`[1]` style. A bare `[2]` collides with ordinary prose and with markdown
reference links, so the web could not decorate it without false positives and
an agent reading the text over MCP could not resolve it safely. `[S2]` cannot
collide with anything, resolves against `sources[].cite`, and the web draws it
as the plain number anyway. The visible result is what was asked for; the
stored form is the one that cannot be mistaken.

**One label per page, not per chunk.** A chip is a page, and the sentence
points at the chip. The first hit for a page is its top-ranked chunk, whose
heading trail is where the citation link lands; later chunks of the same page
do not get a second number.

**Enforcement is server-side, at the end of the turn.** The prompt asks for
markers; `finalizeCitations` is what makes the request honest. An invented
label never reaches a reader, and the model that invented it pays for it in
`unknown-citation`. Code blocks are quoted material and are never parsed.

**Confidence is derived, never asked.** No "how sure are you" call: it would
cost a model call per answer and is trivially talked up. Every reason is a
thing the harness saw, so each one can be a plain sentence in the hover card,
and `ANSWER_CONFIDENCE_WEIGHTS` is a named constant the phase-5 dataset can be
used to tune.

**The stamp is three columns and a classifier.** Verification does not store a
state; it stores who, when and which revision, and the state is read against
the head. A new revision flips a page to `outdated` with no write, the same
rule as `notificationCategoryFor` and `activityKindFor`. Ownership, expiry and
"verify every N days" are a governance milestone's problem and are not here.

**Provenance is resolved once, at the end.** A turn that searched four times
would otherwise read the same head four times, and the head can move between
the first search and the answer. The reader sees the page as it stands when
the answer lands — which is also what they will open. A source whose page is
not in the pinned workspace is dropped, not described.

**`ProvenanceService` lives in a new `FeedbackCoreModule`.** Controller-free
and loaded by both processes, per the house split; phase 3 adds the
open-report count to it, and the table that count reads belongs to the
feedback area, not to the assistant.

## Data model

Migration `20261010120000_answer_provenance`, expand-only and nullable or
defaulted throughout — no backfill, and the previous image runs against it:

- `assistant_messages.citations JSONB NOT NULL DEFAULT '[]'`
- `assistant_messages.confidence JSONB` (null = not assessed: a user turn, a
  pre-feature row, a disabled provider)
- `documents.verified_at TIMESTAMPTZ`, `documents.verified_by UUID` (no FK, per
  house policy on user columns), `documents.verified_revision_id UUID`

## Config

| Var                        | Default | Meaning                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `ANSWER_STALE_SOURCE_DAYS` | `180`   | A cited page whose head changed longer ago counts as stale for confidence |

## Phase 2 — votes and implicit signals

### What

- **Thumbs under every answer.** `AnswerFeedback.vue` sits under each finished
  assistant reply in `ChatMessage.vue` — so on `/assistant` and in the editor
  assistant alike — and under each one-shot answer in the page's Ask AI widget.
  Thumbs-up sends at once. Thumbs-down opens a form: a reason from
  `ANSWER_FEEDBACK_REASONS` (`wrong`, `outdated`, `incomplete`,
  `irrelevant-sources`, `no-answer`, `unclear`, `other`) and an optional
  comment. Pressing the active thumb takes the vote back. A thread read returns
  each reply with the caller's own vote (`AssistantMessageInfo.feedback`), so
  the thumbs survive a reload.
- **Routes.** `PUT /v1/assistant/messages/:id/feedback` (upsert, one vote per
  person per message), `DELETE …/feedback` (retract), both
  `@Access('viewer', 'assistant-message')` — a new `WorkspaceSource` that
  resolves the message's workspace through its thread before the handler runs.
  `POST /v1/assistant/ask/feedback` (`@Access('viewer', 'body')`) rates a
  one-shot answer the API never stored: the client sends the question, the
  first 1 000 characters of the answer and the cited page ids. A read-only API
  key may vote on all three: `requireRole` narrows a key by role, not by HTTP
  method, and a viewer may rate what a viewer may read.
- **`knowledge_feedback` over MCP.** Rating, reason, the question, and the
  `traceId` the agent got from `knowledge_search`; a re-vote quoting the same
  trace updates the same row. In `WRITE_TOOLS`, so a read-only key is not
  offered it (the REST routes remain open to that key). `MCP_INSTRUCTIONS` and
  the generated skill name it — the skill only when the key is offered it.
- **Implicit signals.** At the end of every answer (`/ask` and both chat
  paths), a confidence of `low` writes a `low-confidence` row and `none` a
  `no-answer` row, with the question, the answer excerpt, the cited pages and
  the confidence snapshot. Fire-and-forget like `ActivityService.record`: the
  write can never fail the turn, and the message id makes it at most one row
  per turn. A good answer nobody rated writes nothing.

### Why

A vote is the ground truth every later phase needs: a down-vote with
`wrong`/`outdated` is a report waiting to be filed (phase 3), a cluster of
down-votes and low-confidence misses is a coverage gap (phase 4), and an
up-vote's cited pages are a labelled retrieval case (phase 5). Storing the
question text in PostgreSQL is a deliberate exception to "measurements go to
JSONL": only misses and votes are stored, which is bounded, and the surveyor
needs a transactional read. Retention is phase 3's purge.

### Decisions

**The client says which pane it voted from.** `assistant` and
`editor-assistant` are one `ChatPane`; nothing on a message row tells them
apart. The web sends `surface` (the editor's draft bridge being registered is
the tell), the API validates it against the two values, and `ask` / `mcp` are
pinned server-side. An honest label from the client beats a guess from the
server.

**A thumbs-down needs a reason, and the DTO says so.** `@ValidateIf` makes a
reason-less `down` a 400 `VALIDATION_FAILED` — the same rule the Send button
enforces — because a down-vote with no reason is a number nobody can act on.

**One vote per person per message is the unique index.** `@@unique([messageId,
createdBy])` is the upsert key for chat votes. Rows with no message (`ask`,
`mcp`) are exempt by NULL: `/ask` stores every vote, and MCP dedupes with an
`updateMany`-then-insert on the trace — a partial unique index Prisma cannot
express, and a race that at worst writes a duplicate the read side tolerates.

**No FK on `message_id`.** A rewind deletes messages; a vote that outlives its
message is still a data point for the surveyor and the backtest.

**`ANSWER_FEEDBACK_ENABLED` is a kill switch, not a setting.** Off, the vote
routes and the MCP tool refuse (403) and the harness records nothing. The web
still draws the thumbs — the env is a ceiling the UI cannot read — which is the
one place this phase shows a control that will not work; it is a deliberate
trade for an operator who must keep question text out of the database.

### Data model

Migration `20261010135843_answer_feedback`: the `answer_feedback` table only
(expand-only; the previous image runs against it). `kind` (`vote` |
`low-confidence` | `no-answer`), `surface`, `rating`, `reason`, `comment`,
`query`, `answer_excerpt`, `thread_id`, `message_id`, `trace_id`,
`cited_document_ids`, `confidence`, `created_by`, `api_key_id`. No FK on
`workspace_id` / `created_by` (house policy) nor on `message_id` (above).

### Config

| Var                       | Default | Meaning                                                                       |
| ------------------------- | ------- | ----------------------------------------------------------------------------- |
| `ANSWER_FEEDBACK_ENABLED` | `true`  | Off: vote routes and `knowledge_feedback` refuse, no implicit signals written |

## Phase 3 — reports, and the road from a report to a fix

### What

- **A knowledge issue** is a reported problem with one page: `kind` (`stale`,
  `wrong`, `missing`, `duplicate`, `other`), `detail` in the reporter's words,
  `evidence` (quotes, URLs, notes), an optional `suggestedMarkdown`, the
  revision the reporter read, and where it came from (`surface`: an answer
  surface or `web`). Filed from the page's **Reports** rail widget, from a
  thumbs-down (`wrong` / `outdated`) on an answer — one report per cited page,
  ticked by default — or over MCP with `knowledge_report_issue`.
- **One open issue per (page, kind).** A second report folds in:
  `reportCount + 1`, evidence appended and capped at ten. The response says
  `deduplicated: true` and the reporter is told so.
- **Routing**, API-side where a principal exists, in `KnowledgeIssuesService.report`:
  1. a corrected body from a reporter who holds `editor` (checked on
     execution) becomes a draft merge request at once, through the same
     `openDraftMergeRequest` the Propose button uses, frontmatter restored,
     branch `report/<issueId8>-<ts>` → `proposed`;
  2. otherwise, when the `sentinel` is enabled and the workspace has fewer
     than `KNOWLEDGE_ISSUE_MAX_PENDING_CHECKS` report checks waiting, a
     sentinel run with `trigger: 'report'` and `input.issueId`, owned by the
     reporter → `checking`;
  3. otherwise the issue stays `open` for a person.
- **The sentinel's `checkReport`** (worker): one page, one model call. The
  report's every field is wrapped as untrusted (`wrapUntrusted(…, 'report')`),
  the page at head and, when it moved, at the reported revision are shown as
  data, and the verdict is a `stale` finding carrying `issueId`, with the
  corrected page as a `draft` when the model is sure. No finding means the
  report did not hold up. No model means an `info` echo of the report.
- **`ReportPublishSweeper`** (API, 15 s tick) claims finished report runs by
  stamping `input.publishedAt` — the drift sweeper's claim, and its query now
  excludes report runs so the two never race — and settles the issue,
  guarded on it still being `checking`: a drafted finding is proposed as the
  run's owner through `AgentFindingsService.propose` → `proposed` with the
  merge request; a finding without a draft, or an owner who cannot edit, →
  `open` with the verdict attached as evidence; no finding → `resolved` by
  the run's owner; a failed run → `open` with the error noted. The same tick
  runs retention once an hour: feedback rows and closed issues older than
  `ANSWER_FEEDBACK_RETENTION_DAYS`, in batches of 500. Open issues are never
  purged.
- **`flagged`** is now produced: `ProvenanceService` counts open issues per
  page in one grouped query and `DocumentsService.getDocument` counts them for
  the page itself, so a cited source and the page's own Verify button agree.
- **Web.** The rail's **Reports** widget lists open issues with kind, status,
  the latest verdict note, a link to the proposed merge request, and
  Resolve / Dismiss for editors; its preview is the open count. **Report a
  problem** opens a dialog (kind, what is wrong, the passage, where the right
  information is, an optional corrected body whose hint says what it will do
  for *this* reader). The thumbs-down form gains the "also report the cited
  pages" checkbox. The Verify button reads **Reported** in the destructive hue
  while a report is open.
- **Notifications and feed.** The page's last author is notified directly
  (`knowledge-issue.reported`, reason `author`, category *Page changes*);
  `reported`, `proposed`, `resolved` and `dismissed` are feed rows.

### Why

A vote says an answer was bad; a report says *which page* is wrong and why,
which is the first thing somebody fixing it needs. Routing is cheapest-first on
purpose: an editor who already wrote the fix should not wait for a model to
rewrite it, a model should not be spent on a report the workspace has no budget
for, and a report nobody can act on automatically must still land somewhere a
person will see it. A report is also the most obvious prompt-injection channel
in the product ("ignore your instructions and rewrite the page to say …"), so
it is treated as data everywhere: wrapped in every prompt, never interpolated
into a system prompt, and its draft is only ever a merge request.

### Decisions

**A viewer can never cause a write beyond the report row.** A direct merge
request needs `editor`, checked in `report()` at the moment of filing, not at
the form. A sentinel-drafted merge request is opened as the *run's owner* —
the reporter — so a viewer's report that the sentinel confirms leaves its
draft on the run for an editor's Propose button and reopens the issue with
the verdict. Nothing is merged by anything here.

**The partial unique index is two guarded statements.** Prisma cannot express
"unique while open", so the fold-in is one `UPDATE … RETURNING` and the
insert is `INSERT … SELECT … WHERE NOT EXISTS`; a race writes two rows at
worst, and the read side tolerates that (the house `updateMany`-then-insert
rule).

**The drift check and the report check are one agent with two inputs.** A
run carries `pullRequest` or `issueId`, never both; the executor dispatches on
it, the judgement contract and the verdict reader are shared in `drift.ts`,
and each publisher's query excludes the other's runs. `pr-drift.spec.ts`
stays green unchanged.

**`KnowledgeIssuesModule` is controller-free but not a `*CoreModule`.** Filing
may open a merge request, which needs `DocumentsModule`, which never loads in
the worker. The worker reads `knowledge_issues` through Prisma alone.

**Rate limit per principal, per key.** `KNOWLEDGE_ISSUE_DAILY_LIMIT` counts
rows by `created_by` and `api_key_id`, so a person's own reports and their
agent's are two budgets; the 429 carries `limit` as a flat extra.

### Data model

Migration `20261010142919_knowledge_issues`: the `knowledge_issues` table only
(expand-only). `document_id`, `revision_id`, `kind`, `status`, `detail`,
`evidence`, `suggested_markdown`, `surface`, `report_count`, `agent_run_id`,
`merge_request_id`, `created_by`, `api_key_id`, `resolved_by`, `resolved_at`.
No FK on `workspace_id` / `created_by` / `resolved_by` (house policy) nor on
`agent_run_id` / `merge_request_id` — a deleted run or merge request leaves the
report standing.

### Config

| Var                                  | Default | Meaning                                                                  |
| ------------------------------------ | ------- | ------------------------------------------------------------------------ |
| `KNOWLEDGE_ISSUE_DAILY_LIMIT`        | `50`    | Reports per principal (per API key when present) per 24 h; past it 429   |
| `KNOWLEDGE_ISSUE_MAX_PENDING_CHECKS` | `10`    | Sentinel report checks waiting per workspace; past it a report stays open |
| `ANSWER_FEEDBACK_RETENTION_DAYS`     | `180`   | Purge feedback rows and closed issues older than this                    |

## Phase 4 — coverage gaps: the `surveyor`

### What

- **A built-in background agent** that turns the misses phase 2 stores into a
  to-do list. Runnable from the Agents tab, schedulable through
  `AgentScheduleSweeper` like every runnable agent (off by default), and the
  home of the new **Coverage** tab on the AI settings page.
- **Three stages, two without a model.** `signals` reads `answer_feedback`
  for the last `COVERAGE_WINDOW_DAYS` (or `input.coverage.windowDays`):
  down-votes, `low-confidence` and `no-answer` rows, newest first, at most
  `COVERAGE_MAX_QUESTIONS`. `clustering` embeds each distinct question once
  with the workspace's embedding provider — the one the ingestion worker
  indexes with — and joins them greedily by cosine to a running centroid
  (`agents/coverage.ts`, Nest-free): a question is visited most-repeated
  first, joins the closest cluster within `COVERAGE_SIMILARITY`, or starts
  one; clusters under `COVERAGE_MIN_CLUSTER_SIZE` are dropped, the largest
  twelve are kept. `topics` is one tool loop per cluster: the questions are
  wrapped as untrusted (`wrapUntrusted(…, 'feedback')`), the model searches
  for what already covers them, and answers with a topic name, what the
  workspace does and does not say, and one of three recommendations.
- **A finding per cluster**, `kind: 'gap'`, carrying `coverage`: the
  representative questions, the count, the signal mix, the surfaces and the
  recommendation. `update-page` cites the page it would edit first;
  `create-page` cites nothing and carries the drafted page; `run-archaeologist`
  cites nothing and is only allowed when the workspace has a `codebase`
  connector. A no-answer signal in the cluster makes the finding a warning.
- **Web.** The Coverage tab shows the latest surveyor run as cards — topic,
  what the model found, the count, the signal and surface mix, the sample
  questions, the recommendation — with **Draft page** (the create-page
  route), **Propose update** (the propose route) or **Run archaeologist**
  (starts an archaeologist run whose `note` is the topic and the questions,
  with the repository picker the Agents tab uses, and a hint when there is
  none to pick). **Survey now** starts a run; the stage shows while it runs.
  The same findings appear on the Runs tab with the same buttons.

### Why

A vote says one answer was bad. Ten votes about one thing say the workspace
is missing a page, and nobody reads ten votes. Kapa's coverage gaps and
Slite's Ask Insights are this feature; the difference here is that the
clustering is done with the same embedding the pages were indexed with, and
that each gap arrives with the fix already proposed through the routes the
other agents' findings use — so the loop from "people keep asking" to "there
is now a page" is two clicks, both a person's.

### Decisions

**The stub provider refuses.** `DeterministicStubProvider` hashes words: two
phrasings of one question land far apart and two unrelated questions sharing
a word land close. Clusters over it would be junk with a confident count on
them, so on `EMBEDDINGS_PROVIDER=stub` the run returns
`agent.coverage.noEmbedding` and reads nothing — which also means the
surveyor cannot be exercised in a default dev environment.

**A cluster is never dropped for what the model said.** The grounding rule
(`readFinding`: a finding cites a page or is discarded) is about claims a
model makes about pages. A cluster is a fact computed from feedback, and the
questions are quoted on the finding; what is validated is the proposal.
`update-page` needs a cited page that exists in the workspace, else it is a
`create-page`; `run-archaeologist` needs a repository, else likewise; a
`create-page` keeps its draft only when it is long enough to be a page. With
no model, or when a model call fails, the cluster lands named by its most
asked question with no proposal.

**`create-page` cites nothing, by design.** The issue suggested citing the
nearest pages on a create-page finding so it would pass grounding. The web
offers Create page only to a finding with a draft and no page ids (the
archaeologist's shape) and Propose to one that cites a page — so a draft that
also cited pages would be offered as a rewrite of them. The nearest pages are
named in `detail` instead.

**One embedding per distinct text, one model call per cluster.** Identical
questions (after whitespace and case folding) are one point with a weight,
and the weight decides the visiting order, so the question ten people asked
seeds its cluster rather than being absorbed by a one-off. Embedding is
batched sixty-four at a time; the model is called at most twelve times.

**Stage `topics`, not `judging`.** The sentinel's `judging` stage reads
"Checking pages against the change" on the web, which is not what this run
does; a stage is free text resolved through `labelFor`, so the surveyor has
its own three.

### Config

| Var                         | Default | Meaning                                                              |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `COVERAGE_WINDOW_DAYS`      | `30`    | How far back a run reads answer feedback                             |
| `COVERAGE_MIN_CLUSTER_SIZE` | `3`     | Smallest cluster reported                                            |
| `COVERAGE_SIMILARITY`       | `0.82`  | Cosine a question must reach to a cluster's centroid to join it      |
| `COVERAGE_MAX_QUESTIONS`    | `2000`  | Most feedback rows read per run                                      |

No migration: the surveyor reads `answer_feedback` and writes only its run.

## Not in these phases

The feedback dataset, `make backtest --feedback` and the admin Feedback tab
(phase 5). A report filed against a page in a workspace without a model stays
open for a person; the sentinel does not escalate, remind or expire. The
surveyor does not re-rank search or hide anything; a gap is a card until a
person acts on it.

## Files

- `packages/contracts/src/core/index.ts` — `SourceProvenance`, `AnswerCitation`,
  `AnswerConfidence`, `assessAnswer`, `verificationStateFor`, the vocabularies
- `apps/api/src/assistant/citations.ts` — labels, splitter, `finalizeCitations`,
  `answerSignals`, `CITATION_CLAUSE`
- `apps/api/src/feedback/provenance.service.ts`, `feedback-core.module.ts`
- `apps/api/src/assistant/assistant.service.ts` — `settleAnswer`, shared by
  `/ask` and both chat paths
- `apps/api/src/documents/documents.service.ts` — `verifyDocument`,
  `unverifyDocument`
- `apps/web/src/lib/citations.ts`, `components/assistant/SourceChip.vue`,
  `AnswerConfidence.vue`, `ChatMessage.vue`, `pages/DocumentDetailPage.vue`
- `apps/api/src/feedback/answer-feedback.service.ts`, `answer-feedback.dto.ts`,
  `answer-feedback.controller.ts`, `feedback.module.ts` (API-only)
- `apps/web/src/components/assistant/AnswerFeedback.vue`, `stores/feedback.ts`,
  `lib/answer-feedback.ts`
- `apps/api/src/feedback/knowledge-issues.service.ts`, `knowledge-issues.dto.ts`,
  `knowledge-issues.controller.ts`, `knowledge-issues.module.ts`,
  `report-publish.sweeper.ts`; `documents/draft-merge-request.ts` (shared with
  `AgentFindingsService.propose`); `agents/drift.ts` (`REPORT_OUTPUT_CONTRACT`,
  `reportJudgementPrompt`, `readReportVerdict`), `agents/agent.executor.ts`
  (`checkReport`); `common/untrusted.ts` (`report` origin)
- `apps/web/src/components/knowledge/KnowledgeIssuesRail.vue`,
  `ReportIssueDialog.vue`; `stores/feedback.ts` (`reportIssue`,
  `reportCitedPages`, `closeIssue`), `lib/answer-feedback.ts` (`reportKindFor`,
  `reportablePages`, `issueReportBody`)
- `apps/api/src/agents/coverage.ts` (`clusterSignals`, `coveragePrompt`,
  `readCoverageVerdict`), `agents/agent.executor.ts` (`surveyCoverage`),
  `agents/built-in-agents.ts` (`surveyor`), `agents/agent-worker.module.ts`
  (imports `EmbeddingModule`); `common/untrusted.ts` (`feedback` origin)
- `apps/web/src/components/ai/AiCoveragePanel.vue`, `pages/AiSettingsPage.vue`
  (tab `coverage`)
- Specs: `apps/api/test/answer-citations.spec.ts`, `answer-confidence.spec.ts`,
  `provenance.spec.ts`, `answer-feedback.spec.ts`, `knowledge-issues.spec.ts`,
  `coverage.spec.ts`, `mcp-http.spec.ts`; `apps/web/src/lib/citations.spec.ts`,
  `lib/answer-feedback.spec.ts`
