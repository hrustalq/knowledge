# 38 — Answer provenance: sentence citations, confidence, and the verification stamp

Issue #67, phase 1 of five (the **Answer trust & feedback loop** milestone).
Later phases add votes, reports, coverage gaps and a feedback dataset for the
backtest; this phase is the part they all stand on — an answer that can say
which sentence rests on which page, how old that page is, who wrote it, and
whether anyone has checked it.

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

## Not in this phase

Votes and implicit low-confidence signals (phase 2), `knowledge_report_issue`
and routing to the sentinel or a draft MR (phase 3), the `surveyor` coverage
agent (phase 4), the feedback dataset and `make backtest --feedback` (phase 5).
`flagged` is defined and rendered but nothing produces it yet.

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
- Specs: `apps/api/test/answer-citations.spec.ts`, `answer-confidence.spec.ts`,
  `provenance.spec.ts`, `mcp-http.spec.ts`; `apps/web/src/lib/citations.spec.ts`
