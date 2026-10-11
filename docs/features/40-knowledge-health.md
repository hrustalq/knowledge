# 40 — Knowledge health

Issue [#66](https://github.com/hrustalq/knowledge/issues/66). The workspace-wide
read side of [feature 39](39-page-verification.md): which pages are stale,
unowned, empty, expired, outdated, requested, flagged, inactive or archived;
the counts; one action over many pages; and the per-workspace freshness policy.

Phase status: **the API and the dashboard page are implemented** (this
document). What remains of #66 is the backtest comparison with trust ranking
on and off.

## Routes

All on `v1/knowledge-health`, a controller of its own so none of its literal
segments competes with `DocumentsController`'s `:id`.

| route                                                                                 | role                                  | returns                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `GET ?workspaceId&projectId&filter&ownerId&q&sort&cursor&limit`                       | viewer                                | `KnowledgeHealthRow[]` + `nextCursor`; most neglected first |
| `GET /summary?workspaceId&projectId`                                                  | viewer                                | `total` (live pages) + a count per `HealthFilter`           |
| `POST /bulk {workspaceId, documentIds[≤200], action, ownerId?, note?, intervalDays?}` | editor (`archive`/`unarchive`: admin) | per-id `{ok, error?}`                                       |
| `GET /settings?workspaceId`                                                           | viewer                                | `effective`, `override`, `defaults`                         |
| `PATCH /settings?workspaceId`                                                         | admin                                 | the same, after the sparse write                            |

A row carries title, breadcrumb (`DocumentsService.breadcrumbsFor`), the derived
status, owner, verifier, verified-at, expiry, last activity, `inactive`,
`empty` (`null` while the head's `body_chars` is unknown), archive mark, child
count, and the declared flag with its note.

### Filters

`HEALTH_FILTERS` in `@knowledge/contracts`: `stale`, `unowned`, `empty`,
`expired`, `edited`, `outdated`, `requested`, `flagged`, `inactive`, `archived`.
`stale` is the "needs attention" union — expired ∪ outdated ∪ inactive. Every
filter but `archived` is implicitly "and not archived": an archived page is
neither stale nor unowned, it is put away. No filter lists every live page.

### Sort and paging

`sort=activity` (default, `last_activity_at ASC` — the longest-untouched page
first) or `sort=title`. Keyset cursors over `(sort column, id)`, opaque to the
caller.

## One SQL shape

The list and the summary are a CTE that derives each page's status **the way
`verificationStateFor` does in TypeScript**, clause for clause and in the same
order, with a filter predicate per `HealthFilter` on top:

```sql
CASE
  WHEN d.verification_flag = 'outdated'                          THEN 'outdated'
  WHEN EXISTS (open knowledge_issue for d)                       THEN 'flagged'
  WHEN d.verification_flag = 'requested'                         THEN 'requested'
  WHEN d.verified_revision_id IS NULL                            THEN 'unverified'
  WHEN head IS NULL OR head <> d.verified_revision_id            THEN 'edited'
  WHEN d.verification_expires_at <= now()                        THEN 'expired'
  ELSE 'verified'
END
```

This is the house "classifier with an inverse" pattern (`activityKindFor` /
`typesForCategory`): the predicate is derived in code, the filter is its SQL
inverse so filtering stays in the database. `healthFilterSql` is exhaustive over
the contracts list by its `switch` return type — a filter added there with no
clause here fails typecheck, not at runtime. Change the CASE and change the
TypeScript; the spec pins the TypeScript side.

The summary is `count(*) FILTER (WHERE …)` per filter over the same CTE. No
stored aggregate: a cached copy would be a second answer to the same question.

## Bulk

Every id is checked against `workspaceId` in **one read before anything is
written**. One foreign id means `403` with the offending ids in
`details.foreign` and no change at all. Then each page goes through the same
single-page method a button would call — `verify`, `request`, `outdated`,
`clear` on `VerificationService`; `reassign` through `DocumentsService.setOwner`
so membership is validated in one place; `archive` / `unarchive` with the
subtree — and a page that refuses (archived → `archived`, no head → `no-head`)
is reported per id rather than failing the batch. The caller asked about two
hundred pages, not one.

`archive` and `unarchive` need `admin`, checked explicitly in the controller
with `AccessService.requireRole`, because `@Access` can express one role and
the route's floor is `editor`.

## Settings

`knowledge_health_settings` is a **sparse override** of the env block: one row
per workspace, every column nullable, `null` = inherit. An empty table
reproduces the env behaviour exactly. The response always carries both
`effective` (what applies) and `override` (what the row says), with `defaults`
beside them, so the UI shows what is asked for and what applies — a silent
clamp lies about the configuration. Env values are defaults here, not ceilings.

| key                  | env                                | used by                                             |
| -------------------- | ---------------------------------- | --------------------------------------------------- |
| `reviewIntervalDays` | `VERIFICATION_DEFAULT_REVIEW_DAYS` | expiry on verify, when the page has no own interval |
| `remindBeforeDays`   | `VERIFICATION_REMIND_BEFORE_DAYS`  | the sweeper's reminder window; `0` = none           |
| `inactiveAfterDays`  | `PAGE_INACTIVE_AFTER_DAYS`         | `inactive` everywhere; `0` disables                 |
| `emptyMaxChars`      | `EMPTY_PAGE_MAX_CHARS`             | `empty`                                             |
| `trustRanking`       | `SEARCH_TRUST_RANKING`             | the search re-rank                                  |

`VerificationPolicyService` is the single resolver, a leaf module imported by
documents, search and verification alike.

## On the dashboard

`/knowledge-health` is in the rail beside merge requests and workflows, the
other two places a page is acted on in bulk. `pages/KnowledgeHealthPage.vue`
and `components/health/`:

- **Two tabs**, `?tab=`: **Pages** and **Settings**. The tab and the preset
  (`?filter=`) are opening instructions, so a notification or a doc can point
  at "the unowned pages"; both are written back with `replace`, never `push`.
- **The preset strip** is `HEALTH_FILTERS` plus _All_, each chip carrying its
  count from `/summary`. The counts are `null` until the summary lands and
  draw nothing: "0" would be a claim. Under it, `HealthFilters` narrows by
  title (debounced), owner (the member roster — _unowned_ is a preset, with a
  count, not a roster row) and sort. Every narrowing goes to the server; the
  list is cursor-paged and continues with **Load more**, because a sweep is
  read top to bottom and a scrolling window would fight the selection.
- **`HealthTable`** draws one row per page: the title (a link) over its
  breadcrumb and child count, the state as the same `VerificationBadge` the
  page and the search sheet draw, _Inactive_ and _Empty_ chips, the flag's
  note as text, the owner, who verified it and when with the expiry, and the
  last activity. An archived row is struck through with an archive badge.
- **Selection** is a value, `health-selection.ts`, with the rules every file
  manager has taught people's hands: a click on the checkbox or the row body
  toggles the row and sets the anchor; **shift**-click ranges from the anchor
  and only ever adds; **cmd / ctrl**-click toggles without moving the anchor;
  **Escape** clears (unless the reader is typing). The header checkbox
  selects every loaded row, or none once they all are. The set holds ids, not
  indexes, and is pruned whenever the rows change under it, so a page that
  left the preset is no longer selected. A viewer sees no checkboxes: the
  routes behind the bar are `editor`. Spec: `health-selection.spec.ts`.
- **`HealthBulkBar`** appears above the table while something is selected:
  **Verify** with a review interval, **Reassign** (the page's `OwnerPicker`,
  with _Unowned_ pinned first), and under **More**: Request a check and Mark
  outdated (each with the note the owners will read), Clear verification,
  and — only for an admin, the way the route is — Archive (asks first) and
  Unarchive. One `POST /bulk`; the page toasts the count that succeeded and
  one toast per page that refused (the API's `archived` / `no-head` /
  `not-found` in words, the first five, then "N more"), then clears the
  selection and refetches the list and the counts. A `403` for a foreign id is
  shown through the shared error reader and nothing was written.
- **`HealthPreviewSheet`** opens a page beside the table: the same
  `VerificationBar` the page rail draws — verifying from here is the same act
  as verifying there — over the rendered body, both from the page's own routes
  and fetched only while the sheet is open. A write in the widget refetches the
  dashboard, since the row may just have left its preset.
- **`HealthSettings`** is the policy form. Every row shows what is **asked
  for** (the override, empty meaning inherit) beside what **applies** and the
  server default, because the response carries all three and a form that
  showed only one of them would lie. Saving refetches the rows and the counts:
  the policy is what `inactive`, `empty` and `expired` mean. A viewer sees the
  form read-only; a workspace admin saves.
- **Live:** `document.*` and `revision.*` events invalidate the list and the
  summary (two query keys — a key's leading element is matched whole), so a
  verification made on a page, or by the sweeper, moves the row and the count
  in every open dashboard.

## Security

- Reads are `viewer` over `?workspaceId`, resolved by `AclGuard` before the
  handler runs, like every other `query` source.
- Bulk ids are checked in PostgreSQL against `workspaceId` **before** any write.
- No route here admits a read-only API key for a write (no `@ReadKeyOk`).
- `verification_note` is user or model text and is rendered escaped.
