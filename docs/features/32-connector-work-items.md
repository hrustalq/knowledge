# 32 — Work items and tracker handoff

Оригинал: «add a detail page for connectors like github — we should also be able
to manage linked projects, issues to be able to handoff task to execution + sync
document state based on flows»

Grown by #424 (2026-10-21): «task sources — hand off what the knowledge base
finds to Jira / GitHub / GitLab, and keep the status in sync both ways».

## What

A **work item** is one ticket in an external **tracker** (Jira Cloud, GitHub
Issues, GitLab Issues), as this platform records it: its key, its status, and,
since #424, the knowledge object it is about, its **anchor**. Creating or
attaching that ticket is a **handoff**. The vocabulary is fixed in
[GLOSSARY.md](../../GLOSSARY.md). "Task" is the workflow step and is not used for any of this.

```
reported issue ┐                         ┌ Jira Cloud    (jira connector)
conflict       ├─ handoff ─▶ work item ─▶┼ GitHub Issues (+ org Projects v2 board)
flagged page   │   (anchor)   (row)      └ GitLab Issues (markdown-git / codebase on GitLab)
page           ┘        ▲                       │
                        └── status, both ways ──┘
```

**The tracker is the task list. This side keeps the link and moves the status.**
There is no board here. A chip on the object shows `BILL-123 · In progress`
and links out.

| Where                         | What it shows                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Report row, conflict card     | The ticket chip(s) and **Send to tracker** (create, or attach `BILL-123`)       |
| Verification bar              | The same for a flagged page                                                      |
| `/knowledge-health`           | A **Handed off** filter, the ticket under each row, bulk **Send to tracker**      |
| Knowledge health → Settings   | The handoff rules and the deployment ceiling                                     |
| Connector → **Work items**    | Every ticket on the connector (feature 32's tab, now any tracker)                |
| Connector → **Tracker**       | Project routes, the status map, tracker accounts ↔ members                       |

## Why

Feature 19 made external systems sources of content. The other half of a
repository, or of a Jira site, is the work. A knowledge base that finds a
wrong page, a contradiction or a stale runbook, and then leaves the finding in
its own inbox, has handed the problem to nobody. Teams already have a tracker
where work gets triaged and done. A finding that never reaches that tracker is
not going to be fixed.

Feature 32 already projected GitHub issues into `connector_work_items` and
could open one. #424 kept that model, because it was right, and widened three
things:

- the anchor (a page only → four kinds of object);
- the trackers (GitHub only → Jira, GitHub, GitLab);
- the direction (outbound create only → status moving both ways).

## Decisions

### The model

**A work item is not a link.** `connector_links` maps external *content* onto a
page. Its `document_id` is NOT NULL because the hashes beside it break the
pull → push → webhook → pull echo loop. A work item usually has no page, its
interesting state is a lifecycle, and it is what an inbound event is about.
Folding the two together would make "is this page in sync" and "is this task
done" one question.

**Extend `connector_work_items`, no parallel task table.** #424 adds an anchor
(`source_kind`, `source_id`), the raw tracker status (`external_status`), a
citation (`external_key`, `BILL-123`) and outbound-sync bookkeeping
(`sync_state`, `pending_status`, `sync_error`, `sync_attempts`, `next_sync_at`,
`external_actor_id`). Existing rows are plain projections with a null anchor.
The migration anchored the newest page-attached issue per (connector, page) as
a `document` anchor.

**Anchors are rows only.** The four anchor kinds are:

| `source_kind`  | `source_id` is                 |
| -------------- | ------------------------------ |
| `issue`        | `knowledge_issues.id`          |
| `conflict`     | `knowledge_conflicts.id`       |
| `verification` | `documents.id` of a flagged page |
| `document`     | `documents.id`                 |

A finding inside an agent run's JSON has no id that survives, so it becomes a
reported issue first. A work item has one anchor per connector,
`@@unique([connectorId, sourceKind, sourceId])`, for the anchor's whole
lifetime. A re-raised conflict or a re-flagged page reopens the same ticket.
A new report is a new ticket.

**For Jira, `number` is the site-wide issue id.** One Jira connector serves
several Jira projects, so the key's numeric suffix collides across projects
(`BILL-1`, `OPS-1`). The id does not, which keeps the existing
`(connector, kind, number)` unique valid and the migration expand-only.
`external_key` carries what a person cites.

**Identity is `external_identities`, for attribution only.** The table #76
added for ACL mirroring already maps `(connector, external id) → user`, never
overwriting a manual mapping. #424 reuses it instead of adding a
`tracker_identities` table. A second map would give one GitHub account two
answers.
- A tracker actor seen for the first time is recorded there, and the existing
  resolver tries a linked GitHub account, then a verified email.
- An unmapped actor is `tracker:<connectorId>`, never a person. The activity
  feed shows it as "Tracker".
- Nothing is ever assigned to anybody.

### Status

**Two layers, the classifier derived.** Each row stores two statuses:
- `state` (`open | closed | merged | draft`) is the coarse projection that SQL
  filters on. `merged` is still not `closed`: a merged pull request finished,
  a closed one was abandoned.
- `external_status` is the tracker's own word.

The vocabulary every surface speaks, `open | in_progress | done | wont_do`, is
**derived at read time** by `workItemStatusFor(row, map)` and never stored.
Changing a status map re-labels every row at once.

**Each tracker has a default status map; a connector stores only its
overrides.** `DEFAULT_WORK_ITEM_STATUS_MAPS` (contracts) has two sides:
- `inbound`: raw status → ours, matched case-insensitively, because people type
  Jira status names.
- `outbound`: ours → raw status.

`connectors.config.statusMap` holds the connector's overrides only, and saving
an empty map restores the default. The defaults per tracker:
- **GitHub**: the raw status is the issue state with its close reason folded
  in (`completed` / `not_planned`).
- **GitLab**: only `opened` / `closed`.
- **Jira**: the stock workflow names. `state` follows the status *category*,
  so a team's custom "Shipped" still closes.

When the map cannot express a transition, the failure is reported as the
tracker error, not guessed.

**Sync is one comparison, not hooks.** `WorkItemSyncSweeper` compares, every
`WORK_ITEM_SYNC_TICK_MS`, each anchored row's derived status and `updated_at`
with its anchor's state and time (`syncDecision`, pure, tested in CI). The
newer side wins.

| Ticket | Anchor | Newer  | Result                                         |
| ------ | ------ | ------ | ---------------------------------------------- |
| closed | open   | ticket | **inbound**: resolve the anchor                |
| closed | open   | anchor | **outbound**: reopen the ticket, comment "raised again" |
| open   | closed | anchor | **outbound**: close the ticket                 |
| open   | closed | ticket | nothing: a resolved report or closed conflict is final |

Nothing in the issue, conflict or verification services knows trackers exist.
This one comparison covers both directions, a lost webhook, a lost Redis
event and a restart, because it reads state, not messages about state. The
cost is up to one tick of latency.

An anchor's time comes from:

| Anchor                | Time                                                            |
| --------------------- | --------------------------------------------------------------- |
| reported issue        | `resolved_at`, else `created_at`                                |
| conflict              | `resolved_at`, else `detected_at`; a superseded conflict has no opinion |
| flagged page          | the flag's `source.at`                                          |
| page with no flag     | the latest verification activity row (pages have no `updated_at`, and clearing a flag wipes its source) |

**A tracker close never verifies a page.** Verifying is a person's act (feature 39). An inbound close:
- resolves a report (`done`), or dismisses it (`wont_do`);
- resolves or dismisses a conflict, with "Closed in BILL-123" as the note;
- clears a page's flag only when the closer maps to someone who may edit the
  page *now*. The verification stamp is left as it was.

The page owner gets one `work-item.closed` notification (verification
category).

**Outbound is API-side, with backoff and a visible failure.** A pending
transition is retried 5 times with exponential backoff, then marked `failed`
with the tracker's error, which shows on the chip with a Retry. A ticket
deleted on the tracker becomes `orphaned`. Unlinking stops sync and never
closes the ticket. An anchor that was deleted gets its ticket closed with a
comment, and the row is dropped.

### Transport

**Polling is the guaranteed path, webhooks the fast path.** Each tick polls
one tracker connector that has anchored tickets, or an enabled label-filtered
ticket trigger covering it ([49](49-agent-triggers.md#ticket-triggers-and-the-scribe)), round robin, from
`connectors.task_cursor` ("updated since"). A connector with a content run in
flight is skipped. A labelled ticket with no row (lost, or created before its
row) is re-anchored from its `knowledge-ref:` footer.

Webhooks only get the same projection written sooner:

| Tracker | Webhook                                                                 |
| ------- | ----------------------------------------------------------------------- |
| GitHub  | The App webhook, feature 32's, which also handles `projects_v2_item`    |
| Jira    | A signed webhook on `/v1/connectors/:id/webhook`                        |
| GitLab  | An `Issue Hook` with `X-Gitlab-Token` on the same route                 |

**The sweeper runs in the API process only.** It writes to somebody else's
tracker and resolves reports in a person's name, and "the worker generates,
the API publishes". It also polls there, not in `ConnectorScheduleSweeper`
(worker). It is provided by `ConnectorsModule`, not by
`WorkItemHandoffModule`, because the stdio MCP server imports the latter, and
a second process running the sweeper would double every transition. The
worker-side `task.update` step stays feature 32's documented exception.

### Trackers

**`TrackerAdapter` sits beside `ConnectorAdapter`, never on it.** The content
interface's verbs all mean something else here. `TrackerRegistry.trackerFor(row)`
decides per row, and no new connector kinds were added:

| Tracker | Connector                                                  | Notes                                                                                                   |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GitHub  | `markdown-git` / `codebase` on github.com                  | Feature 32's service refactored onto the interface                                                      |
| Jira    | `jira`                                                     | Its JQL is now optional (a tracker-only connector). The content pull moved to `/rest/api/3/search/jql`. |
| GitLab  | `markdown-git` / `codebase` whose host contains `gitlab`   | Addressed by the whole namespace path (`RepoHost.path`), so subgroups work                              |

- **Jira moves through workflow transitions, not to a status.** The adapter
  picks the available transition whose target status, or failing that its
  name, matches. One that is unavailable from the current status is an error,
  never a guess.
- **Jira's poll** is `(labels = "<label>" OR key in (<anchored keys>)) AND
  updated >= <cursor − 1 day>`. JQL dates are in the API user's timezone,
  which the API cannot see, and re-reading a day is cheap and idempotent.
- **Jira bodies** are ADF built from three kinds of line (text, link, footer).
  There is no markdown→ADF converter.

**Projects v2: org boards only, best effort.** A route may name a board URL,
which is resolved at save time to the board and its single-select Status
field. A user-owned board is refused, because the App's
`organization_projects` permission cannot reach it. A handoff adds the card in
Todo. A transition moves it to the matching column, and if that write fails
the issue's own state is still the status. The App asks for
`organization_projects: write` and the `projects_v2_item` event. A card moved
on the board refreshes the issue's board names; its column is not read back as
a status.

### Ticket text and routing

**Summary, link, footer, never content.** A ticket has:
- **title**: the object's title, or its id when any page involved is
  restricted;
- **body**: one sentence saying why, a deep link, and
  `knowledge-ref: <kind>:<id>`, in the connector's locale;
- **label**: `knowledge`, or `config.workItemLabel`.

The tracker's readers are not the page's readers. Comments are not mirrored in
either direction.

**Routing is per knowledge project.** `project_tracker_routes` has one row per
project, holding the connector plus a Jira project key and issue type, or a
GitHub board. A project without a route has the connector picked by hand, and
the rules leave it alone.

**Every read takes an `AccessScope`.** Work-item lists drop a row on a page the
caller cannot open, never with a 403 and never with a title. This covers the
connector tab, MCP `knowledge_list_work_items`, the assistant's
`task_list`/`task_read`, and the chip. A conflict-anchored row also needs its
other page to be visible.

### Rules

**Three scalar columns, all off, under an env ceiling.** The rules live on
`workspace_settings`, following the `lint_policy` precedent:
- `work_item_issues` (`high | medium | all`): a report has no severity, so
  `issueRankFor` ranks it. `wrong`, or three or more reports, is high. `stale`
  or `missing`, or two reports, is medium.
- `work_item_conflicts` (`on`).
- `work_item_verification` (`outdated | all`).

Each tick the oldest admitted objects with no ticket are handed into their
route, up to `WORK_ITEM_AUTOCREATE_MAX_PER_TICK` across all workspaces. They
are attributed to `rule:<kind>`. The settings form shows the ceiling beside
the choice.

## Surface

```
POST   /v1/work-items/handoff                              editor (on the anchor's page, checked in the service)
GET    /v1/work-items?workspaceId&sourceKind&sourceId      viewer (scoped)
GET    /v1/work-items/rules?workspaceId                    admin
PUT    /v1/work-items/rules                                admin
GET    /v1/projects/:id/tracker-route                      viewer
PUT    /v1/projects/:id/tracker-route                      admin
DELETE /v1/projects/:id/tracker-route                      admin
GET    /v1/connectors/:id/tracker-routes                   viewer
PUT    /v1/connectors/:id/status-map                       admin
GET    /v1/connectors/:id/work-items                       viewer (scoped)
POST   /v1/connectors/:id/work-items                       editor
POST   /v1/connectors/:id/work-items/:workItemId/link      editor (documentId, or sourceKind + sourceId)
DELETE /v1/connectors/:id/work-items/:workItemId/link      editor
POST   /v1/connectors/:id/work-items/:workItemId/retry     editor
POST   /v1/connectors/github/webhook                       public, HMAC (App)
POST   /v1/connectors/:id/webhook                          public, per-connector secret (Jira, GitLab)
```

- **MCP**: `knowledge_list_work_items` (scoped) and `knowledge_handoff_work_item`
  (`WRITE_TOOLS`, `guard.ws(…, 'editor')`).
- **Assistant**: `task_list`, `task_read`, `task_create`, `task_comment`, now
  on any tracker.
- **Workflow step**: `task.update`.
- **Events**: every tracker emits `repo.issue.*`. The agent trigger event
  `work-item.updated` is heard on `repo.issue.closed|reopened|labeled`, with
  subject `issue:<workItemId>`.
- **Activity**: `connector.work-item.handoff | status-changed | unlinked`.
- **Notification**: `work-item.closed`.

Env (all with defaults): `WORK_ITEM_SYNC_ENABLED` (`true`, the kill switch),
`WORK_ITEM_SYNC_TICK_MS` (`15000`), `WORK_ITEM_AUTOCREATE_MAX_PER_TICK` (`20`).

## Setup

**GitHub App**, on `https://github.com/settings/apps/<your-app>`:

| Section                  | Setting                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| Repository permissions   | Issues: **Read and write**; Pull requests: **Read and write**        |
| Organization permissions | Projects: **Read and write** (was read; #424 moves cards)            |
| Webhook                  | **Active: on**, URL `$API_PUBLIC_URL/v1/connectors/github/webhook`   |
| Webhook secret           | a random string → `GITHUB_APP_WEBHOOK_SECRET` (`GH_APP_WEBHOOK_SECRET` in the GH `production` environment) |
| Subscribe to events      | Issues, Issue comment, Pull request, Push, Release, **Projects v2 item** |

Each installation must accept the raised permission. Until it does, board
writes fail quietly and everything else works.

**Jira**: a `jira` connector with the site URL and `email:api-token`. Set a
**Default project key**, or route projects with a Jira project key. For
seconds-fast sync, add a Jira webhook (issue updated) to
`$API_PUBLIC_URL/v1/connectors/:id/webhook` with the connector's webhook
secret. Without it, polling still syncs.

**GitLab**: a `markdown-git` or `codebase` connector on the GitLab repository
with a project or group access token (`api` scope). For seconds-fast sync, add
an Issues hook to the same per-connector URL with the connector's secret as its
token.

Direction (b), ticket → agent work, shipped in #433: a labelled ticket starts
a `scribe` run whose drafts open as merge requests and are linked back on the
ticket. See [49](49-agent-triggers.md#ticket-triggers-and-the-scribe).

## Deliberate deferrals

- **No comment mirroring and no assignee push.** Identity is attribution only.
- **No OAuth for Jira or GitLab** until somebody cannot issue a token.
- **No user-owned Projects v2 boards, no Jira Data Center, no
  Plane/Gitea/YouTrack/Redmine.** The adapter interface is sized for them.
- **A self-hosted GitLab whose host name lacks `gitlab`** is `other`, as
  `repoHost` always classified it. A per-connector host override would fix it,
  and nobody has asked.
- **Orphaned tickets** show on the chip and in `/knowledge-health`. Nobody is
  notified, because an orphan is nobody's in particular to act on.
- **Work items are not indexed or graphed.** A ticket is not a page.
- **Reconcile reads up to 500 anchored rows a tick, oldest-written first.** An
  updated-since watermark is the upgrade once a workspace holds that many open
  handoffs.

## Verification

- CI (no network, no DB):
  - `test/work-item-status.spec.ts`: status maps, rule ranks, the footer.
  - `test/work-item-sync.spec.ts`: the sync contract driven through an
    in-memory tracker (handoff, close on the tracker, re-raise, resolve, no
    echo), backoff, GitHub's raw statuses and refs.
  - `test/jira-tracker.spec.ts`, `test/gitlab-tracker.spec.ts`,
    `test/github-projects.spec.ts`: recorded API shapes through a mocked
    `safeFetch`.
  - `test/work-items.spec.ts`: feature 32's state mapping and signature checks.
- Local, against live infra: `test/work-item-handoff.e2e-spec.ts` (7 cases).
  It runs the real services over Postgres with a fake tracker, and covers
  every acceptance item that needs a database:
  - one ticket per anchor;
  - a close by poll alone dismisses a conflict with nobody attributed;
  - a re-raise reopens the same ticket;
  - resolving closes it without echo;
  - five failures end in `failed` with the error, and retry recovers;
  - an unmapped closer leaves the flag and the stamp alone;
  - the rules create nothing when off or unrouted, and no more than the
    ceiling when on.
- By hand, after deploy, from the laptop:
  1. Hand off a report to a GitHub connector. The issue has the title, link,
     footer and `knowledge` label.
  2. Close it as not planned on GitHub. Within seconds (webhook) or one poll,
     the report reads dismissed.
  3. Re-flag a verified page that had a ticket. The same ticket reopens with a
     "raised again" comment.
