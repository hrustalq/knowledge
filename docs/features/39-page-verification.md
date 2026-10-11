# 39 — Page verification, ownership, freshness and archive

Issue [#66](https://github.com/hrustalq/knowledge/issues/66), the first step of the
#65 "trust loop". Extends the verification stamp that
[feature 38](38-answer-provenance.md) shipped: a page now has an **owner**, a
**review interval** that makes the stamp **expire**, a declared
**requested / outdated** flag that a person, the sentinel or an agent over MCP
can set, an **inactive** reading derived from its activity clock, and an
**archive** state. Search, the assistant's `ask` and MCP `knowledge_search`
multiply every hit's score by the page's state, so a verified page ranks above
an unverified one and a page known to be wrong ranks last.

Phase status: **API, ranking and MCP are implemented** (this document). The
expiry sweeper and its notifications, the sentinel integration, the page-level
status bar and the knowledge-health dashboard ([feature 40](40-knowledge-health.md))
follow in later pull requests of the same issue.

## What is stored, what is derived

The row stores little, and nothing that says "verified":

| column                                       | meaning                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `verified_at / verified_by / verified_revision_id` | the stamp (feature 38) — _is_ the verified state                                |
| `verification_expires_at`                    | `verified_at + interval`; `NULL` = never                                              |
| `review_interval_days`                       | the page's own interval; `NULL` inherits the workspace default, `0` = never           |
| `verification_flag`                          | the one state a person or agent **declares**: `requested` or `outdated`, else `NULL` |
| `verification_note`, `verification_source`   | why, and who/what set it (`person`, `drift`, `curator`, `mcp` + run or PR)           |
| `owner_id`                                   | the responsible member; `NULL` = unowned                                              |
| `last_activity_at`                           | bumped by `ActivityService.record` for every `FRESHNESS_ACTIONS` action               |
| `archived_at / archived_by`                  | put away                                                                              |
| `expiry_reminded_at / expired_notified_at`   | the sweeper's claim-once stamps; both reset on every verify                           |
| `document_revisions.body_chars`              | body length without frontmatter, written by the ingestion normalizer                  |

Everything a reader sees is **one predicate**, `verificationStateFor` in
`@knowledge/contracts`, over the row, the head revision, the open-report count
and the clock. In precedence order:

| state        | when                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| `outdated`   | `verification_flag = 'outdated'` — declared wrong                                      |
| `flagged`    | an open knowledge issue (feature 38, phase 3)                                          |
| `requested`  | `verification_flag = 'requested'`                                                      |
| `unverified` | no stamp                                                                               |
| `edited`     | stamped at an older revision than the head                                             |
| `expired`    | stamped at the head, `verification_expires_at` passed                                  |
| `verified`   | stamped at the head, inside its interval                                               |

A new revision, a passing deadline or a closed report each change the answer
**with no write** to the document row. That is what lets search, the dashboard,
the sweeper and the page agree without a job keeping them in step, and it is
why there is no stored `verification_state` column: a stored copy would be a
second answer to the same question.

`edited` is a rename of what feature 38 called `outdated` for the head-moved
case. The two had to part: an edit after a check is usually a fix and must not
be ranked like a page known to be wrong, and the dashboard's "Outdated" filter
must not list every page that was touched yesterday. `verificationIsStale`
names the three states under which the stamp no longer vouches for the page
(`edited`, `expired`, `outdated`); `assessAnswer` counts a cited source in any
of them as stale.

**Inactive** is `isInactive(last_activity_at, inactiveAfterDays)` — no write,
comment or verification inside the window. Read analytics is another milestone,
so a page read daily but never touched looks inactive. **Empty** is
`body_chars <= emptyMaxChars`; `NULL` body_chars (revisions indexed before the
column) reads as _unknown_, never as empty.

## Transitions

All in `VerificationService` (`apps/api/src/verification/`), each a **single
guarded statement** — `updateMany` over `{ id, archivedAt: null }` — followed by
one activity record. Two replicas racing on the same page: one wins the
`updateMany`, the other records nothing.

| route                                           | role             | effect                                                                                                         |
| ----------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /v1/documents/:id/verify {intervalDays?}` | editor           | stamp at head; set interval when given; compute expiry; clear flag, note, source and both sweeper stamps        |
| `DELETE /v1/documents/:id/verify`               | editor           | back to `unverified`: stamp and flag both go                                                                   |
| `POST /v1/documents/:id/verification-request {note?}` | viewer     | `requested`; notifies the owner (or the last verifier)                                                          |
| `POST /v1/documents/:id/outdated {note?}`       | editor           | `outdated`; notifies the owner                                                                                  |
| `PATCH /v1/documents/:id {ownerId?, reviewIntervalDays?}` | editor | owner must be a workspace member (`null` = unowned); a stamped page's expiry moves with its interval            |
| `POST /v1/documents/:id/archive {includeDescendants?}` | editor    | one statement over `path LIKE '<own path>%'`; default `true`, so a parent is never archived over live children |
| `POST /v1/documents/:id/unarchive`              | editor           | the inverse                                                                                                    |

Verifying refuses a page with no finalized head (`409`, `details.reason =
no_head_revision`) and an archived page (`409`, `document_archived`). Verifying
is a **person's act**: there is no MCP tool for it, by design.

Events: `document.verified`, `document.unverified`,
`document.verification-requested`, `document.outdated`,
`document.verification-cleared`, `document.owner-changed`, `document.archived`,
`document.unarchived` (plus `-expiring` / `-expired` from the sweeper later).
`activityKindFor` files them all under `curate`. The directed ones
(`requested`, `outdated`, `expiring`, `expired`, `owner-changed`) reach the owner
under a new **`verification`** notification category, which a person can mute,
with reason `owner` ranked between `author` and `assigned`.

## Archive

Archive is a **visibility default, not an access boundary**. An archived page:

- leaves `GET /v1/documents`, `GET /v1/documents/tree`, search, `ask` and MCP
  `knowledge_search` / `knowledge_list_documents` unless `includeArchived` is
  passed;
- stays readable by id (`GET /v1/documents/:id`, `/content`, `/revisions`);
- refuses writes — upload, revision, finalize, merge request, metadata patch —
  with `409 { details.reason: 'document_archived' }` until unarchived.

A live child of an archived parent surfaces as a tree root, by the same orphan
rule legacy rows already use; nothing is hidden by accident. The graph does not
know about archive: a put-away page keeps its edges, so the hybrid walk reaches
it and PostgreSQL decides whether to show it.

## Ranking

`SearchService.search` joins PostgreSQL for the stamp, the flag, the owner, the
activity clock and the archive mark along with the title, derives each hit's
status, and then:

1. drops archived pages (unless `filters.includeArchived`);
2. multiplies the fused score by `trustWeight(status, inactive)`;
3. re-sorts, and only then cuts to `k`.

The weights are exported constants (`TRUST_WEIGHTS`), guesses to be tuned with
`make backtest`:

| state                             | factor |
| --------------------------------- | ------ |
| verified                          | 1.15   |
| unverified, requested, edited     | 1.0    |
| expired, flagged                  | 0.85   |
| outdated                          | 0.5    |
| inactive (on top of the above)    | × 0.9  |

Multiplicative, so it works for RRF, cosine-only and max-normalized BM25 scores
alike. A verified page must not beat a clearly more relevant unverified one,
which is why the top factor sits near 1. With the re-rank on, `fetchK` is at
least `2k` so a demoted hit has something to be displaced by; with it off,
`fetchK` is exactly what it was before — RRF over a longer candidate list is a
different ranking, and "off" promises the old one. Archived pages drop either
way: archive is not a demotion.

Every hit carries `trust: { status, verifiedAt, expiresAt, ownerId, inactive }`.
New filters: `verificationStates[]` and `includeArchived`. The backtest event
records `trustApplied` so two runs can be compared.

The kill switch is `SEARCH_TRUST_RANKING` (env) combined with the workspace's
`trustRanking` override (feature 40 settings); both are read through
`VerificationPolicyService`, the one place the effective policy is resolved.

## Assistant and MCP

- The `ask` tool's search results carry `status`, `verifiedAt`, `inactive` and
  the owner's display name — trusted PostgreSQL metadata, placed **outside** the
  untrusted content wrapper. The free-text `verification_note` stays inside it.
  The citation clause tells the model to prefer verified pages and to say so when
  it relies on an outdated, expired or edited one. The rule is a prompt; the
  enforcement is `assessAnswer`, which counts stale sources into the confidence.
- MCP `knowledge_search` returns `trust` on every hit and takes `includeArchived`;
  `knowledge_list_documents` returns `verification`, `verificationFlag`,
  `ownerId` and `archivedAt` per node and takes `includeArchived`;
  `knowledge_get_document` returns every stored field. New write tool
  **`knowledge_flag_document { workspaceId, documentId, state, note? }`**:
  `requested` needs `viewer`, `outdated` needs `editor` (the REST twins' roles),
  the source is recorded as `mcp`, and it is hidden from read-only keys via
  `WRITE_TOOLS`. `MCP_INSTRUCTIONS` and the generated skill explain the states.

## Configuration

All defaults, not ceilings — a `knowledge_health_settings` row overrides each
per workspace (feature 40):

| var                                | default |
| ---------------------------------- | ------- |
| `VERIFICATION_DEFAULT_REVIEW_DAYS` | `90`    |
| `VERIFICATION_REMIND_BEFORE_DAYS`  | `7`     |
| `PAGE_INACTIVE_AFTER_DAYS`         | `180`   |
| `EMPTY_PAGE_MAX_CHARS`             | `40`    |
| `VERIFICATION_SWEEP_ENABLED`       | `true`  |
| `SEARCH_TRUST_RANKING`             | `true`  |

## Migration

`20261011120000_page_verification` is expand-only: every column is nullable or
defaulted, so the previous release's image runs against it unchanged and a
rollback leaves the columns inert. Two backfills from facts the database already
holds: `last_activity_at` from the page's creation, its last finalized revision
and its last freshness action in `activity_log`; `owner_id` from the author of
the first revision, when that author is a real account (not the zeros dev stub)
and still a member of the page's workspace — otherwise `NULL`, which the
dashboard shows as unowned. `body_chars` is not backfilled (content lives in
MinIO); the sweeper fills it in bounded batches, and until then "empty" reads as
unknown.

## Module split

- `VerificationPolicyModule` — a leaf: the effective settings of a workspace.
  Imported by `DocumentsCoreModule` (expiry on verify / interval change),
  `SearchCoreModule` (the switch and the inactivity window) and
  `VerificationCoreModule`.
- `VerificationCoreModule` — `VerificationService` and `KnowledgeHealthService`,
  controller-free and auth-free, loadable in both processes; `McpCoreModule`
  imports it for `knowledge_flag_document`.
- `VerificationModule` — API-only: `VerificationController` (mounted on
  `v1/documents` beside `DocumentsController`; every route is `:id/<literal>`,
  so there is no ordering hazard) and `KnowledgeHealthController`.

`DocumentsCoreModule` also imports `FeedbackCoreModule` now, for the one
open-report count `verificationStateFor` reads; list, tree, detail and search
all use `ProvenanceService.openIssueCounts`.

## Decisions

- **A content change does invalidate the stamp** — derived, no write, the page
  reads `edited` until re-verified. This was the released behaviour of feature 38
  and is kept; there is no `resetOnMerge` flag.
- **No agent verifies.** `knowledge_flag_document` sets `requested` or
  `outdated`; only `POST …/verify` and the bulk `verify` by a person with
  `editor` set the stamp. Enforced at the point of action, not in a prompt.
- **`requested` beside `flagged`.** A knowledge issue (feature 38) is a report
  with evidence that the sentinel checks; a request is a lighter "please look".
  Both exist; an open issue outranks a request in the derived state.
- **Archive is not permission.** Documented as such; a viewer can open an
  archived page by id.
