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

## Why merging is fast-forward-preconditioned

The target head must equal the merge base. If the target branch advanced past
where the source forked, the merge is refused with 409 and a comparison link —
**3-way content merge is future work**, and the way forward is to rebase the
source branch (write a new revision on top of the target head) and try again.

That is a deliberate reduction rather than a missing feature: a document is one
body of prose, so a content merge that goes wrong produces a page that reads as
if two people wrote alternate paragraphs, and nobody can tell from the result
which half is stale. Refusing is legible; guessing is not.

Two strategies, both carrying the source head's bytes verbatim:

- `merge-commit` → a true merge node: `revision_parents` order **1 = target
  head, 2 = source head**, which is what makes the DAG readable afterwards.
- `squash` → a single-parent revision on the target head.

Either way the merge revision goes through the normal
finalize → outbox → reindex pipeline, so a merged page is indexed by the same
code path as an edited one and there is no second write path to keep correct.

## Why the merge runs under a branch-row lock

The fast-forward check above is an unlocked read. Under `READ COMMITTED` it sees
the last committed head and _not_ a concurrent merge's uncommitted advance, so
two mergers could both pass it and the second would commit over the first's
head. The merge therefore re-takes the decision inside the transaction:

```sql
SELECT head_revision_id FROM document_branches WHERE id = $1 FOR UPDATE
```

and 409s with `reason: 'diverged'` if the head moved since. It is the first
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

Three gates, all evaluated before any side effect, all reported as a `reason`
the client can branch on:

| `reason`    | Gate                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `draft`     | `merge_requests.is_draft` — PATCH-toggleable, never merges while set        |
| `approvals` | fewer than `MR_REQUIRED_APPROVALS` (default 1) non-author approvals         |
| `diverged`  | the fast-forward precondition above, with `comparisonUrl`                   |

The author's own approval is excluded from the count. That exclusion is exactly
why the approval gate is **skipped for the dev principal and for MCP**: in
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
`currentHeadRevisionId` and `comparisonUrl` are written at the top level of the
throw and arrive under `details` — typed as `MergeGateConflictDetails` in
`@knowledge/contracts/reviews`. **Never nest `details` manually**: a hand-built
`details` key would be hoisted into `details.details`.

The `diverged` 409 shares its shape with the `If-Match` optimistic-concurrency
409 on `POST /:id/revisions` (`RevisionConflictResponse`), which is described in
[02-persistence-revisions.md](02-persistence-revisions.md) — same envelope, same
`comparisonUrl`, different trigger.

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
`apps/web/src/components/merge-requests/thread-anchors.ts`; server-side
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

## Data model

| Table                     | Notes                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge_requests`          | `status` open \| merged \| closed, `is_draft`, `author_id`, `assignee_id` (no FK — advisory), `approved_by` Json, `strategy`, `merged_revision_id`.     |
| `merge_request_reviewers` | Join table with `added_by`. Advisory; validated against `workspace_members`.                                                                            |
| `merge_request_threads`   | `resolvable` (default true), `resolved`/`resolved_by`/`resolved_at`, `source` human \| ai, `anchor_type` line \| text \| section \| entity, `anchor` Json. |
| `merge_request_comments`  | Flat, `createdAt`-ordered. `reply_to_id` self-FK `SetNull` (attribution), nullable `updated_at`, `agent_key`, `pending`.                                 |
| `saved_filters`           | `Int` PK. `(owner_id, workspace_id, name)` unique; `query` Json holds status + search + chips.                                                           |

## Routes

| Route                                                  | Access             | Notes                                            |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------ |
| `POST /v1/documents/:id/merge-requests`                | editor · document  | 409 when an open MR exists for the same pair     |
| `GET /v1/documents/:id/merge-requests`                 | viewer · document  | newest first, no merge base                      |
| `GET /v1/merge-requests`                               | viewer · query     | cursor-paginated, filters + `counts`             |
| `GET/POST /v1/merge-requests/filters`                  | viewer · query/body| declared **before** `merge-requests/:id`         |
| `GET/PATCH/DELETE /v1/merge-requests/filters/:filterId`| viewer ·saved-filter| integer id; other owners' rows 404               |
| `GET /v1/merge-requests/:id`                           | viewer ·merge-request| heads, merge base, approvals, reviewers        |
| `PATCH /v1/merge-requests/:id`                         | editor ·merge-request| title/description/isDraft/assigneeId, open only|
| `POST /v1/merge-requests/:id/reopen`                   | editor ·merge-request| closed → open; merged is terminal              |
| `PUT /v1/merge-requests/:id/reviewers`                 | editor ·merge-request| replace-set, members only                      |
| `GET /v1/merge-requests/:id/diff?semantic=`            | viewer ·merge-request| merge-base compare, structural always          |
| `POST /v1/merge-requests/:id/approve`                  | editor ·merge-request| records the calling principal                  |
| `POST /v1/merge-requests/:id/merge`                    | editor ·merge-request| 409 `draft` \| `approvals` \| `diverged`        |
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
self-approvals never count.

## Web

`/merge-requests` (`MergeRequestsPage.vue`) and `/merge-requests/:id`
(`MergeRequestDetailPage.vue`, tabs overview/changes/structure/impact per
[plan.md §8](../../plan.md)) were the first consumers of the generated
vue-query client. `components/knowledge/DiffView.vue` was extracted from the
revisions view and takes inline threads through a slot;
`components/merge-requests/` holds `MergeRequestCard.vue`,
`MergeRequestList.vue`, `MergeRequestSearchBar.vue`, `MrSidebar.vue` (assignee +
reviewers with approval ticks), `AiCheckPane.vue` (a `/v1/assistant/review` run
against the source head, handling `enabled:false`), `MergeWidget.vue` (readiness
checklist, renders the gate 409s), `ThreadCard.vue` (collapsible, starts
collapsed when resolved), `CommentComposer.vue` (split **Comment ▾** button
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
`subjectId`.

## Limits

3-way content merge is not attempted anywhere — a diverged target is a 409 and a
rebase. Server-side re-anchoring of outdated line anchors is future work; the
client falls back to the Discussion tab. Reviewers and assignee are advisory and
will never gate a merge. Merge base is absent from every list response by
design. Saved views are private with no sharing mechanism, and the integer id
they are addressed by is workspace-agnostic — the `?view=` link only resolves
for its owner.
