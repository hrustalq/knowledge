# 38 — Answer provenance: sentence citations, confidence, the verification stamp, and votes

Issue #67, phases 1 and 2 of five (the **Answer trust & feedback loop**
milestone). Later phases add reports, coverage gaps and a feedback dataset for
the backtest. Phase 1 is the part they all stand on — an answer that can say
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

## Not in these phases

`knowledge_report_issue` and routing to the sentinel or a draft MR (phase 3),
the `surveyor` coverage agent (phase 4), the feedback dataset and
`make backtest --feedback` and the admin Feedback tab (phase 5). `flagged` is
defined and rendered but nothing produces it yet, and a `wrong`/`outdated`
down-vote does not yet file a report against the cited pages. Feedback and
closed issues are not purged yet (phase 3's retention tick).

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
- Specs: `apps/api/test/answer-citations.spec.ts`, `answer-confidence.spec.ts`,
  `provenance.spec.ts`, `answer-feedback.spec.ts`, `mcp-http.spec.ts`;
  `apps/web/src/lib/citations.spec.ts`, `lib/answer-feedback.spec.ts`
