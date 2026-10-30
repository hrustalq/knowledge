# 05 — Merge requests & review

## What this is

A GitLab-shaped review layer over the revision DAG: a merge request bundles two
branch heads, their merge base, the diff between them, approvals, reviewers and
anchored discussion, and — when every gate passes — writes one new revision onto
the target branch through the ordinary ingestion pipeline.

The DAG itself, branches, `CompareService` and the `?structural=` / `?semantic=`
compare modes belong to [02-persistence-revisions.md](02-persistence-revisions.md);
this document covers only what merging and reviewing add on top. `plan.md`
[§8](../../plan.md) is the authoritative shape (three views per merge request:
Changes, Structure, Knowledge impact).

Everything lives in `apps/api/src/documents/`: `merge-requests.service.ts`,
`merge-requests.controller.ts`, `merge-request-threads.service.ts`,
`saved-filters.service.ts`.

## Why merging is 3-way, and refuses only overlaps

Each page is merged against its own merge base (`findMergeBase` on the revision
DAG, never the project commit graph — doc 71's third invariant). A page whose
target head still is the merge base lands the source head's bytes, as a
fast-forward would. A page whose target moved lands the **line-level 3-way
merge** of base, target and source (`three-way.ts`: `node-diff3` with
`excludeFalseConflicts`, which agreed with `git merge-file` on 3,000 of 3,000
fuzzed edits in the #636 spike). Two people editing different paragraphs of
one page both merge without either redoing their work.

Where the two sides change the same or adjacent lines, the merge is still
refused, now with `reason: 'conflict'` and `conflicts` — every conflicting page
by id with its hunks as line ranges (`MergeConflictHunk`: base, target, source).
That keeps the old stance where it mattered: a content merge never guesses
between two rewrites of one passage. Before #636 it refused every moved target,
because a merge that guessed would read as two people writing alternate
paragraphs. Only non-overlapping changes merge now, and an overlap still
refuses. The verdict is git's, so a person resolving locally sees the same
conflict the server reported. Spec pages (YAML or JSON) merge the same way; a
merged spec that no longer parses is refused by `finalizeRevision`'s validator,
and the merge rolls back.

**Update branch** (`POST /v1/merge-requests/:id/update-branch`) is how a
conflict is resolved, and why there is no rebase: history is append-only, so
the source branch is never rewritten. It merges the target into the source on
every page behind it, each as a revision on the source branch with parents
**1 = source head, 2 = target head**, and one project commit for the lot (its
second parent the target's head commit). Afterwards the merge base is the target
head, so the merge request's own merge is a fast-forward. A conflicting page
needs a resolution: the whole body, pinned to the target head it was resolved
against (a newer one is 409 `diverged`), with no `<<<<<<<`/`>>>>>>>` marker line
left (400). `GET :id/conflicts` serves the conflict view: how many pages are
`behind`, and each conflicting page the reader may open with its hunks and the
merge carrying git's markers labelled with the branch names. A resolution that
keeps the source's body unchanged is still finalized (`dedupe: false`): it is
the merge node that moves the merge base.

`publishBranch`'s `onTopOf` (the default heads the author reviewed) now matters
only on a conflict: a listed head lets that page land with the author's body.
A clean page ignores it.

Two strategies, both carrying the merged bytes:

- `merge-commit` → a true merge node: `revision_parents` order **1 = target
  head, 2 = source head**, which is what makes the DAG readable afterwards.
- `squash` → a single-parent revision on the target head.

Either way the merge revision goes through the normal
finalize → outbox → reindex pipeline, so a merged page is indexed by the same
code path as an edited one and there is no second write path to keep correct.

## Why the merge runs under a branch-row lock

The heads the merge above was computed on are an unlocked read. Under `READ COMMITTED` it sees
the last committed head and _not_ a concurrent merge's uncommitted advance, so
two mergers could both pass it and the second would commit over the first's
head. The merge therefore re-takes the decision inside the transaction:

```sql
SELECT head_revision_id FROM document_branches WHERE id = $1 FOR UPDATE
```

and 409s with `reason: 'diverged'` if the head moved since: the 3-way result was
computed against the old head, so it is retried rather than landed. It is the first
branch-row lock every concurrent merger takes, so merges into one branch
serialize rather than deadlock.

The merge revision and the MR's own status flip commit **together**. They did
not, once, and the gap left the worst possible pair of facts: the target branch
advanced — so the MR was no longer mergeable — while its status was still
`open`, permanently, with no route back. The status flip is itself a guarded
`updateMany(where: { status: 'open' })`, so a concurrent merge or close of the
same MR loses the race and rolls the merge revision back with it. Four S3 round
trips live inside the transaction (source GET, draft PUT, and `finalizeRevision`'s
HEAD + GET), hence the raised `timeout: 30_000, maxWait: 10_000`.

## Why the gates skip the dev principal

Five gates, all evaluated before any side effect, all reported as a `reason`
the client can branch on. They run in this order: `draft`, `approvals`, `lint`,
`conflict`, `breaking-api`. `diverged` is no gate any more: it is the race above.

| `reason`       | Gate                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| `draft`        | `merge_requests.is_draft` — PATCH-toggleable, never merges while set        |
| `approvals`    | fewer than `MR_REQUIRED_APPROVALS` (default 1) non-author approvals         |
| `lint`         | under the `block` lint policy, the source head's style check is still to come or has an unresolved error-severity violation, and no admin overrode it; with `checkStatus`, `blockingCount`, `checkId` ([below](#style-lint)) |
| `conflict`     | the 3-way merge of a page overlaps, with `conflicts` (page ids and hunks) and the first page's `documentId`, heads and `comparisonUrl` |
| `diverged`     | a target head moved while the merge landed (the lock above), or an Update-branch resolution names an old target head |
| `breaking-api` | a spec merge request with breaking changes under the `block` policy and no current ack, with `breakingCount` ([below](#breaking-api-changes)) |

The author's own approval is excluded from the count. That exclusion is exactly
why the approval gate (and the lint gate, which follows it) is **skipped for
the dev principal and for MCP**: in
`AUTH_MODE=none` the dev principal's `userId` IS the zeros `AUTHOR_ID_STUB`
(`00000000-0000-0000-0000-000000000000`), so every dev-created MR is authored by
the only identity that can approve it — self-approval exclusion would deadlock
every merge in a dev environment. MCP stdio has no principal at all. The
implementation reads `MR_REQUIRED_APPROVALS` only when
`principal && principal.mode !== 'dev'`, and otherwise requires 0. Same trust
semantics as `AccessService.requireRole`, documented in
[06-auth-acl.md](06-auth-acl.md).

Merging into a **protected** target branch additionally requires the workspace
`admin` role — checked through `requireRole`, and likewise short-circuited for
the dev principal and skipped when there is no principal.

## The flat-extras error pattern

Custom 409s are thrown as a flat object:

```ts
throw new ConflictException({ statusCode: 409, message, reason, ...extras });
```

`ApiExceptionFilter` (`common/api-exception.filter.ts`, registered in `main.ts`
only) destructures `statusCode`/`error`/`message`/`code` out of the body and
hoists **everything left over** into `details` of the `ApiErrorPayload`
envelope. So `reason`, `requiredApprovals`, `approvals`,
`currentHeadRevisionId`, `comparisonUrl`, `breakingCount`, `checkStatus`,
`blockingCount` and `checkId` are written at the top level of the
throw and arrive under `details` — typed as `MergeGateConflictDetails` in
`@knowledge/contracts/reviews`. **Never nest `details` manually**: a hand-built
`details` key would be hoisted into `details.details`.

The `conflict` and `diverged` 409s share their shape with the `If-Match` optimistic-concurrency
409 on `POST /:id/revisions` (`RevisionConflictResponse`), which is described in
[02-persistence-revisions.md](02-persistence-revisions.md) — same envelope, same
`comparisonUrl`, different trigger.

## Breaking API changes

A merge request on an OpenAPI or AsyncAPI document
([feature 52](../features/52-api-reference.md)) can be refused for what it does
to the API's clients. The diff is `ApiSpecDiffService.diff(documentId, from,
to)`: the pure classifier `api-specs/api-diff.ts` over both revisions, every
change one rule from the closed `API_CHANGE_RULES` catalogue
(`@knowledge/contracts/api/diff`) with a fixed severity. It is cached in
`revision_diffs` under the format `api-semantic-v1`. The version is part of the
format name, so a rule change misses the cache instead of serving old
verdicts. Operations match by method and folded path (channels by address and
action), never by array position, so reordered parameters are no change.

The policy is `workspace_settings.api_breaking_change_policy`: `off`, `warn` or
`block`, with `null` meaning `warn`. It is a sparse settings row with no env
ceiling, and `warn` never refuses a merge, so an empty table merges exactly as
before. One predicate, `breakingBlocks(policy, diff, mr)`, decides: `block`,
at least one breaking change from merge base to source head, and no current
acknowledgement. `GET /v1/merge-requests/:id/api-changes` (its `blocked`
field) and `merge()` both call it, so the panel cannot say "mergeable" while
the gate says no.

In `merge()`, `assertBreakingAcknowledged` runs **last**, after the 3-way
merge, because it parses two specs. It judges the diff from the merge base to
the source head: the diff the panel showed, and, when the merge is clean, what
the merge adds to the target. It throws the
flat-extras 409 `{ reason: 'breaking-api', breakingCount }`. On a page, or
under any policy but `block`, it returns before parsing anything.

**The ack is pinned to the source head.** `POST /v1/merge-requests/:id/breaking-ack`
(admin) writes `breaking_ack_by`, `breaking_ack_at` and
`breaking_ack_revision_id`; `DELETE` withdraws it. The ack is current only
while `breaking_ack_revision_id` equals the source branch head. A later push
makes it stale (`ack.current: false`), so an author cannot add breaking changes
after an admin approved the first ones. Both acts record an activity note.

A connector-synced spec ([feature 52](../features/52-api-reference.md), repo
sync) never writes the page after its first sync. Every later change opens a
merge request with the conflict reason `spec-changed`, in every sync mode, so
this gate sees the change before readers do. The connector sweeper supersedes
an older open spec MR for the same file, as it does for `regenerated` wiki
pages.

Not built: the system thread on the merge request for each breaking change to
a linked operation. Posting it needs a trigger when the source branch's
revision is finalized, and a GET must not post.

## Style lint

Issue #74 ([feature 53](../features/53-doc-quality.md)). A merge request is
checked against the styleguide of its page's project, and the check can hold
the merge. Everything lives in `documents/lint/`: the pure `lint-check.ts`,
`LintChecksService` in `LintCoreModule` (both processes, so `DocumentsModule`
can import it for the gate), and the API-only `LintModule` with the two
sweepers and `LintController`.

**One row per head.** `merge_request_checks` is unique on `(merge_request_id,
kind, head_revision_id)`. `LintTriggerSweeper` (30 s) inserts the row for an
open, non-draft merge request whose source head has none, and that insert is
the claim. It enqueues a `linter` run as the merge request's author
(`trigger: 'merge-request'`). A newer head marks a still-waiting check
`skipped` and cancels its run. Stored statuses are `pending`, `passed`,
`failed`, `error` and `skipped`; `running` is derived from the run.

**Only what the merge request adds is linted.** The executor reads the
merge-base diff through `CompareService` (in `DocumentsCoreModule` for this)
and `changedText` keeps the added lines, so a violation already on the target
is not reported. Every quote is grounded again in the whole source head and
stored as a `text` anchor on a `style` finding.

**The API publishes.** `LintPublishSweeper` (15 s) claims a finished check by
stamping `published_at` in one guarded `updateMany`, then reconciles with the
lint threads of earlier checks (`planLintThreads`): a standing violation keeps
its thread, open or resolved; a new one gets a resolvable `source: 'ai'`
thread with `agent_key = 'linter'`, `check_id` and `rule_id`; an open thread
whose violation is gone is resolved. Identity is rule plus quote, with
overlapping quotes of one rule counted as one. Only lint threads are read, so
a person's thread is never touched. A run older than 24 h is `stale` and not
published.

**The policy.** `workspace_settings.lint_policy` and `projects.lint_policy`,
`off | warn | block`, null inheriting. `STYLE_LINT_POLICY` (default `off`) is
the ceiling and the policy of every scope that sets none. A disabled `linter`
agent makes it `off`. `resolveLintPolicy` returns requested beside effective,
and `GET`/`PUT /v1/lint-policy` serves it.

**The gate.** `lintGate()` is the one predicate; `LintChecksService.gate()`
feeds it and both `merge()` and `GET …/checks` (its `gate` field) call it.
Under `block` it holds while the current head's check is missing, pending or
running, or while it is `failed` with unresolved, resolvable lint threads whose
`rule_id` the run's findings marked `error` (`errorRuleIds`, the severity the
rule had when the run read it). `passed`, `error` and `skipped` never hold:
fail-open. Resolving the last such thread through the ordinary `PATCH
…/threads/:threadId` unblocks the merge; no route was added for it.

It runs after `approvals` and before `conflict`, because updating the branch
would only produce a new head to lint, and is skipped where the approval gate is
(`lintGateEnforced`).

**The override.** `POST /v1/merge-requests/:id/checks/:checkId/override`
(admin, `{ reason }`) is on `MergeRequestsController` beside `breaking-ack`,
because it needs `AuditService` and the activity recorder and
`LintChecksService` must stay worker-safe. It applies to the current head
only and to a `pending` or `failed` check, in one guarded `updateMany`, and is
recorded in `audit_logs` (`merge-request.lint-override`) and as a
`merge-request.updated` activity with `changed: ['lintOverride']`. A later
push is linted afresh and needs its own pass or override.

## Why merge base is computed on detail reads only

The merge base is a BFS over the parent map. Computing it per row would make a
50-row list page do 50 graph walks, so the service splits its response builders:

- `toInfo(mr, mergeBase, threadStats)` — the projection. List endpoints call it
  as `toInfo(mr, null, …)`, and `MergeRequestInfo.mergeBaseRevisionId` is
  documented in contracts as _always null in list responses_.
- `statsFor(ids)` — one batched
  `mergeRequestThread.groupBy({ by: ['mergeRequestId', 'resolved', 'resolvable'] })`
  per response, so list rows never N+1 on thread counts either.
- `toDetail(mr)` — the single helper pairing `mergeBaseOf` + `statsFor`, used by
  detail reads and by every mutation response.

`threadStats.unresolved` counts only `resolvable && !resolved`. A plain comment
is a remark, not an open request; counting one as unresolved would leave a
readiness checklist blocked forever by someone saying "nice".

`GET /v1/merge-requests` also returns `counts { open, merged, closed }` from a
second `groupBy('status')` over a **shared `baseWhere` that omits the status
filter**, so the UI's tab badges reflect every status under the _same_
search/author/assignee/reviewer/branch scope. Branch filters match the name as a
case-insensitive substring (`auth` finds `feature/auth`) — typing a branch name
out in full, exactly, is not a filter.

## Review discussions

`merge_request_threads` carries the anchor and the resolved state;
`merge_request_comments` carries the words. Thread **writes** require the MR to
be `open`; **reads always work**, so a merged MR keeps its discussion readable.

A thread is `resolvable` (default true) or not — GitLab's two shapes of remark.
`setResolved` 400s on a plain comment, and only resolvable threads count toward
`unresolved`. `source` is `human` or `ai`, because the assistant posts as the
person who ran it and `author_id` therefore cannot carry that fact.

**Comments are flat and `createdAt`-ordered, but they are not un-attributed.**
Both `merge_request_comments` and `document_comments` carry `reply_to_id`
(self-FK, `onDelete: SetNull`): a reply may name the remark it answers. This is
_attribution, not nesting_ — the list stays flat, there is no indent tree, and a
thread anchored to one passage is short enough not to want one. `SetNull` is the
load-bearing half: deleting a comment orphans the replies that pointed at it
rather than cascading them away, because removing them would delete other
people's words.

Comment editing and deletion are **author-only** (403 otherwise) — a discussion
is a record of who said what, and letting a reviewer restate someone else's
point would make it a worthless one. `updated_at` is nullable so "never edited"
and "edited at once" stay distinguishable, which is what the _edited_ marker
keys off. Deleting the last comment of a thread deletes the thread, so the
client drops the card instead of rendering an empty one.

Anchors are best-effort. A `line` anchor pins `revisionId` + `line` + `excerpt`
at comment time; once the branch advances the client shows the thread as
**outdated** rather than re-anchoring it (client matching in
`apps/web/src/modules/merge-requests/model/thread-anchors.ts`; server-side
re-anchoring is future work). The quote-based `text` anchor that review mode and
page comments use is the same `ReviewThreadAnchor` union — see
[../features/13-review-mode.md](../features/13-review-mode.md) and
[../features/15-page-comments.md](../features/15-page-comments.md). Agents
answering an `@mention` post into these same tables; see
[../features/21-agent-mentions.md](../features/21-agent-mentions.md).

## Reviewers and assignee are advisory

`merge_request_reviewers` is a join table and `merge_requests.assignee_id` a
single nullable column (no FK, same rationale as `author_id`). Neither gates a
merge — the approval count does. Both are validated against `workspace_members`,
and both drive filters (`?reviewerId=`, `?assigneeId=`) and directed
notifications (`merge-request.review-requested`, and `assigned` carried on
`merge-request.updated`), because reviewer and assignee ids live in
`activity_log.metadata`, which never reaches the event bus — see
[../features/22-notifications.md](../features/22-notifications.md).

`UpdateMergeRequestDto.assigneeId` uses `@ValidateIf(o => o.assigneeId !== null)`
plus `@Matches(UUID_RE)` so that `undefined` (absent, leave alone) and `null`
(clear it) stay distinguishable on the wire.

## Saved filters are addressed by number

`saved_filters` is the **one table keyed by `Int @id @default(autoincrement())`**
instead of a uuid, deliberately: a saved view is addressed by the person who
saved it (`#7`) and by the URL (`?view=7`), and a uuid is unusable in both.

Rows are **private to their owner**. Every read is scoped by `ownerId`, and
someone else's row **404s rather than 403s** — a private row should not confirm
it exists. The AclGuard has already established that the caller is a viewer of
the owning workspace, so losing membership takes the view with it; ownership
itself is checked in the service, because the guard knows workspaces, not rows.
The dev principal owns every row it can reach (same trust as `requireRole`),
or nothing saved before a login would ever be reachable again in dev.

Two consequences worth keeping:

- The routes are declared on `MergeRequestsController` **before**
  `merge-requests/:id` — Nest matches in declaration order, and `filters` would
  otherwise be read as a merge-request id (the `documents/tree` precedent). The
  path param is `:filterId`, not `:id`, so the integer never reaches a UUID
  pipe, and `@ApiParam({ name: 'filterId', type: Number })` is what keeps the
  generated client typing it as a number.
- The new `WorkspaceSource` `'saved-filter'` needed AclGuard's **first non-uuid
  parse**, `intId()`, beside the existing `uuid()`.

`query` is Json holding the _whole_ narrowing — status tab + search text + chips
— because a view that restored only the chips could not express "my _open_
reviews". `normalizeQuery` rebuilds the chip list rather than trusting it, so a
row written by an older client cannot put a non-array where the bar expects one.
`@@unique([ownerId, workspaceId, name])`: re-saving under an existing name is an
update, and the UI offers exactly that rather than a second "My reviews".

## Provenance: who opened it

Issue #73. `merge_requests.provenance` records who opened a merge request:
`manual` (a person, the column default), `agent` (an `AgentFindingsService`
finding or relation, or the assistant's propose-change and relation tools) or
`captured` (an agent-session capture or a chat save, with `capture_id` for a
capture's). The closed list is `MR_PROVENANCES` in contracts, and a CHECK
constraint mirrors it.

- **An argument, never a DTO field.** `MergeRequestsService.create(…, {
  provenance, captureId })` and `openDraftMergeRequest` take it from the code
  path that opens the merge request, so a client cannot label its own merge
  request `agent`. `POST /v1/documents/:id/merge-requests` always writes
  `manual`.
- **It changes no gate.** A captured merge request merges under the same
  approvals, draft and divergence rules as any other. It is authored by the
  person whose key captured it, so their own approval does not count.
- **Filtering stays in SQL.** `GET /v1/merge-requests?provenance=` and the
  web's "Opened by" token filter on the column. The list card badges `agent`
  and `captured`, and a captured merge request's detail page shows a
  provenance strip with the agent, repository, branch and session
  (`MrProvenance.vue`).
- The migration backfilled existing rows: merge requests referenced from
  `agent_runs.findings[*].mergeRequestId` became `agent`, and chat saves became
  `captured`.

**A target with no head.** A captured new page, like a chat save, is created
with no revision on its default branch and its content behind the merge
request ([features/50](../features/50-agent-memory.md)). `merge` already
handled a head-less target: `parentOrder` is 1 and there is no fast-forward
check. The diff now renders it as all-added through
`CompareService.compareWithNothing`, with `compare.from: null`, where it used
to answer 400. While such a merge request is open,
`documents.pending_merge_request_id` keeps the page out of every list. The
merge clears it in the same transaction, and closing leaves the stub hidden so
a reopen still merges.

## Data model

| Table                     | Notes                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge_requests`          | `status` open \| merged \| closed, `is_draft`, `author_id`, `assignee_id` (no FK — advisory), `approved_by` Json, `strategy`, `merged_revision_id`, `provenance` manual \| agent \| captured, `capture_id`, nullable `breaking_ack_by` / `breaking_ack_at` / `breaking_ack_revision_id`. |
| `workspace_settings`      | Sparse, one row per workspace; `api_breaking_change_policy` (null = `warn`) and `lint_policy` (null = the `STYLE_LINT_POLICY` ceiling) beside the try-it `api_try_proxy_mode`. `projects.lint_policy` overrides the lint policy per project. |
| `merge_request_checks`    | One style check per `(merge_request_id, kind, head_revision_id)`: `status`, `reason`, `styleguide_id`, `agent_run_id`, `counts`, `published_at`, `overridden_by` / `overridden_at` / `override_reason`. |
| `merge_request_reviewers` | Join table with `added_by`. Advisory; validated against `workspace_members`.                                                                            |
| `merge_request_threads`   | `resolvable` (default true), `resolved`/`resolved_by`/`resolved_at`, `source` human \| ai, `anchor_type` line \| text \| section \| entity, `anchor` Json, `check_id` / `rule_id` on a lint thread. |
| `merge_request_comments`  | Flat, `createdAt`-ordered. `reply_to_id` self-FK `SetNull` (attribution), nullable `updated_at`, `agent_key`, `pending`.                                 |
| `saved_filters`           | `Int` PK. `(owner_id, workspace_id, name)` unique; `query` Json holds status + search + chips.                                                           |

## Routes

| Route                                                  | Access             | Notes                                            |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------ |
| `POST /v1/documents/:id/merge-requests`                | editor · document  | 409 when an open MR exists for the same pair     |
| `GET /v1/documents/:id/merge-requests`                 | viewer · document  | newest first, no merge base                      |
| `GET /v1/merge-requests`                               | viewer · query     | cursor-paginated, filters (incl. `provenance`) + `counts` |
| `GET/POST /v1/merge-requests/filters`                  | viewer · query/body| declared **before** `merge-requests/:id`         |
| `GET/PATCH/DELETE /v1/merge-requests/filters/:filterId`| viewer ·saved-filter| integer id; other owners' rows 404               |
| `GET /v1/merge-requests/:id`                           | viewer ·merge-request| heads, merge base, approvals, reviewers        |
| `PATCH /v1/merge-requests/:id`                         | editor ·merge-request| title/description/isDraft/assigneeId, open only|
| `POST /v1/merge-requests/:id/reopen`                   | editor ·merge-request| closed → open; merged is terminal              |
| `PUT /v1/merge-requests/:id/reviewers`                 | editor ·merge-request| replace-set, members only                      |
| `GET /v1/merge-requests/:id/diff?semantic=`            | viewer ·merge-request| merge-base compare, structural always          |
| `POST /v1/merge-requests/:id/approve`                  | editor ·merge-request| records the calling principal                  |
| `POST /v1/merge-requests/:id/merge`                    | editor ·merge-request| 409 `draft` \| `approvals` \| `lint` \| `conflict` \| `diverged` \| `breaking-api` |
| `GET /v1/merge-requests/:id/conflicts`                 | viewer ·merge-request| `behind`, conflicting pages the caller may open (hunks + marker text), `hiddenPages` |
| `POST /v1/merge-requests/:id/update-branch`            | editor ·merge-request| merges the target into the source; `resolutions` per conflicting page |
| `GET /v1/merge-requests/:id/api-changes`               | viewer ·merge-request| spec MRs: classified diff, linked pages per operation, policy, ack, `blocked` |
| `POST/DELETE /v1/merge-requests/:id/breaking-ack`      | admin ·merge-request | pins / withdraws the ack at the source head    |
| `GET /v1/merge-requests/:id/checks`                    | viewer ·merge-request| style checks per head, `gate` for the caller   |
| `POST /v1/merge-requests/:id/checks/lint`              | editor ·merge-request| lints the current head again                   |
| `POST /v1/merge-requests/:id/checks/:checkId/override` | admin ·merge-request | `{ reason }`; current head, pending or failed  |
| `POST /v1/merge-requests/:id/close`                    | editor ·merge-request|                                                |
| `GET/POST /v1/merge-requests/:id/threads`              | viewer / editor    | reads work on merged/closed MRs                  |
| `POST .../threads/:threadId/comments`                  | editor             | optional `replyToId`                             |
| `PATCH/DELETE .../threads/:threadId/comments/:commentId`| editor            | author-only (403); last comment removes thread    |
| `PATCH /v1/merge-requests/:id/threads/:threadId`       | editor             | resolve / unresolve; 400 on a plain comment       |

MCP exposes `knowledge_create_merge_request`, `knowledge_list_merge_requests`
(with `search`), `knowledge_get_merge_request` (`includeDiff`, `semantic`),
`knowledge_approve_merge_request`, `knowledge_close_merge_request`,
`knowledge_comment_merge_request` and `knowledge_merge_revision` — all acting as
the stub identity, which is why the approval tool's description spells out that
self-approvals never count. `knowledge_diff_api_spec` (read-only) returns the
classified spec diff between two revisions; there is no ack tool. Style checks
are not on `knowledge_get_merge_request`; `knowledge_lint_draft` lints a draft
before it is proposed.

## Web

`/merge-requests` (`MergeRequestsPage.vue`) and `/merge-requests/:id`
(`MergeRequestDetailPage.vue`, tabs overview/changes/structure/impact per
[plan.md §8](../../plan.md), plus review mode and, on a spec only, **API
changes** from `entities/api-operation/components/ApiChangesPanel.vue`) were the first consumers of the generated
vue-query client. `modules/documents/components/DiffView.vue` was extracted from the
revisions view and takes inline threads through a slot;
`components/merge-requests/` holds `MergeRequestCard.vue`,
`MergeRequestList.vue`, `MergeRequestSearchBar.vue`, `MrSidebar.vue` (assignee +
reviewers with approval ticks), `AiCheckPane.vue` (a `/v1/assistant/review` run
against the source head, handling `enabled:false`, above a Style section with
the current head's check), `MergeWidget.vue` (readiness
checklist, renders the gate 409s; on a spec MR a breaking-changes row with
**Acknowledge** / **Withdraw** for admins; a style row with **Check again** and,
for admins, **Override**), `ThreadCard.vue` (collapsible, starts collapsed when
resolved; a lint thread shows its rule chip), `CommentComposer.vue` (split **Comment ▾** button
whose second item is _Start thread_ — the `resolvable` flag), `mr-ui.ts` and
`use-members.ts`.

The filter rail (`SavedFilterRail.vue`) is **closed by default** — `kn_filterrail`
via `getFilterRailOpen()`, unset meaning _closed_, the opposite polarity to the
app rail: that one is how you get anywhere, this is a tool you reach for. It is
deliberately **not a second funnel**: it never offers a field to add (the search
bar still owns composition), it shows the _complete_ narrowing as a manifest —
status and title text included, which the chip bar structurally cannot — and it
remembers it. `mr-filters.ts` holds `useMrFilterFields()` (axis definitions
lifted out of the search bar so both render the same labels) plus
`toSavedQuery`/`fromSavedQuery`/`sameQuery`; `sameQuery` drives the _edited_
marker and Update-vs-Save-as-new, so an applied view never silently claims to
show what it was saved as. The toggle's badge counts search + chips but **not**
status — the tabs already spell that out, and badging it would mark the default
view as filtered on arrival. `.kn-filter-rail` collapses by
`grid-template-rows` below `lg` and by `width` at `lg`: one element, two
mechanisms, because a second instance would be a second copy of the rail's state.

Events: `merge-request.created/updated/reopened/approved/merged/closed/`
`review-requested/comment.created/comment.resolved/comment.deleted`. The
live-cache `merge-request.*` rule invalidates detail/diff/threads keys by
`subjectId`, and every merge request's `conflicts` key, since any merge moves a
target.

## Limits

The 3-way merge is line-level: two edits to one long line conflict, as in git.
`GET :id/conflicts` merges every behind page on each read, with no cache.
Server-side re-anchoring of outdated line anchors is future work; the
client falls back to the Discussion tab. Reviewers and assignee are advisory and
will never gate a merge. Merge base is absent from every list response by
design. Saved views are private with no sharing mechanism, and the integer id
they are addressed by is workspace-agnostic — the `?view=` link only resolves
for its owner.
