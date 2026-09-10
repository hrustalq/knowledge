# 22 — Notifications

Оригинал: «implement full notifications logic, add document tracking (notify
subscribers on change), merge requests, workflow results, etc»

## What this is

A per-person layer over the workspace-wide event bus: a durable inbox, a
**watch** relationship so a page or a whole project can be followed, and
directed notifications for the three things that must reach you whether you
watch or not — being mentioned, being assigned, being asked to review.

| Surface                  | What it does                                                              |
| ------------------------ | ------------------------------------------------------------------------- |
| Topbar bell              | Unread badge, the last eight rows, mark-all-read. Sheet on a phone.        |
| `/notifications`         | The full inbox: tabs per category, unread filter, paging.                  |
| Watch button             | Watching / Not watching / Muted, on a page, a merge request and a project. |
| `/settings/notifications`| Mute categories, stop auto-watching, review everything you follow.         |

## Why

The platform already emitted 50+ event types and recorded an activity feed, but
both are broadcasts — they answer *what happened here*, never *what happened
that concerns me*. A page you own could be rewritten, a merge request could name
you as reviewer, and a workflow run you started could fail, with nothing telling
you. The only way to find out was to go and look.

## Decisions

### One implicit door, one explicit door

`EventsPublisher.publish` is the one function every event already passes through
— `ActivityService.record` on the API side, and the ingestion, workflow, agent,
import and connector processors publishing directly on the worker side. The
fan-out hooks **there** rather than at those call sites: the same "single
injection point" stance `GraphService` takes for the mandatory workspace
predicate, and the reason a notifiable event type added later costs one entry in
`notificationCategoryFor` and no wiring at all.

`NotificationsService` takes `PrismaService` and nothing else, which is what
lets `EventsModule` import `NotificationsCoreModule` outright instead of behind
a `forwardRef`. It must stay that way.

The second door is explicit — `notify`, `notifyMentions`, called from
`MergeRequestsService.setReviewers`/`update` and both thread services — because
those recipients are **not on the bus**: reviewer and assignee ids live in
`activity_log.metadata`, which `ActivityService.record` deliberately does not
forward onto the event, so the fan-out could not find them even in principle. It
is also the more honest shape: a review request is a directed act, not news.

The recursion this obviously invites is closed off by the code table —
`notification.created` maps to no category, so a notification cannot fan out
into another one.

### Coalescing

An unread row with the same `(userId, type, coalesceKey)` is updated —
`createdAt` bumped, `metadata.count` incremented, `reason` upgraded by
precedence — rather than duplicated. Once read, the next event opens a fresh
row.

It earns its keep three times over. Five replies to a thread while you were away
are one line. Three edits to one page are one line. And it dissolves the
ordering problem between the two doors: a mentioned person who *also* watches
the page ends with a single row whose reason is `mention`, whichever door fired
first — so the two doors need no knowledge of each other.

`updateMany` then insert, rather than an upsert: the natural key is "(user,
type, subject) among unread rows", a partial unique index Prisma cannot express.
A race can therefore duplicate a row at worst — cosmetic, and self-correcting on
read; a raw-SQL index Prisma could not see would be the worse trade.

### Category is derived, reason is stored

`notificationCategoryFor(type)` is the counterpart of `activityKindFor`, and for
the same reason is **not** a column: the event type is the durable fact, the
category is a reading of it that may be re-cut without a migration. Filtering
still happens in SQL, via `typesForCategory` inverting the classifier over the
closed `KNOWN_EVENT_TYPES` vocabulary.

`reason` *is* a column — it is a fact about the fan-out decision, not derivable
from anything else. And because a directed reason describes a row better than
the event that carried it, `notificationRowCategory(type, reason)` lets the
reason win: a mention arrives as an ordinary `*.comment.created`, and an
assignment arrives as `merge-request.updated`, a type that is deliberately not
notifiable at all because a title edit is not news. Without that split, muting
`comment` would silently mute mentions, and an assignment would fall out of
every badge while still counting toward the total.

### `revision.finalized`, not `revision.indexed`

Finalizing carries the author as its actor; the worker's indexing events carry
none. Notifying on `revision.indexed` would therefore tell authors about their
own edits — the one thing an inbox must not do.

### Most specific watch wins

A subscription row on the page decides; only when there is none does the
containing project's row apply. Otherwise muting one noisy page would be undone
by watching its project, and explicitly watching one page inside a muted project
would be impossible.

`muted` is a **stored row**, not the absence of one. Involvement auto-subscribes
— commenting on a page starts watching it — so a person who unwatched would be
re-added by their next comment. "Stop telling me about this" has to be a fact
that survives.

### The dev principal keeps an inbox

Actor-suppression ("never notify me about my own action") would leave the inbox
permanently empty in `AUTH_MODE=none`, where every request is the same dev
principal — making the feature untestable without a bootstrapped key. So
suppression is skipped for the dev identity, reusing the already-exported
`actorIdentities`/`isDevActor`. The same accommodation the merge-request
approval gate makes for the same principal.

### Addressed frames on a shared bus

`KnowledgeEvent` gained `userId?` meaning *deliver only to this person*, filtered
in both fan-out sites (`EventsSubscriber.stream`, `LiveGateway.fanOut`). Without
it, pushing a notification over the workspace-wide bus would tell every peer who
is being notified about what. It also gained `reason?`, present only on
`notification.created`, so a client can tell the one reason worth interrupting
somebody for (being named) from the rest.

## Surface

```
GET  /v1/notifications?workspaceId=&unread=&category=&limit=&cursor=   viewer,query
GET  /v1/notifications/unread-count?workspaceId=                       viewer,query
POST /v1/notifications/read            { workspaceId, ids?|all, category? }   viewer,body
GET  /v1/notifications/subscriptions?workspaceId=&subjectType=&subjectId=     viewer,query
PUT  /v1/notifications/subscriptions   { workspaceId, subjectType, subjectId, state }  viewer,body
GET  /v1/notifications/preferences?workspaceId=                        viewer,query
PUT  /v1/notifications/preferences     { workspaceId, … }              viewer,body
```

Every route is `viewer` — whoever may read a workspace may be told about it —
and every read and write is scoped to `principal.userId` inside the service, so
**no new `WorkspaceSource` was needed**: there is no route that takes somebody
else's id. That is the `SavedFiltersService` stance (the guard knows workspaces,
rows are owned). The service additionally checks that a subject belongs to the
workspace the guard authorised, or a member of A could watch a page in B by
naming its id and be told its title on every edit.

Three tables: `notification_subscriptions` (unique per user+subject),
`notifications` (denormalized `title`, no stored link — the web derives one from
`(type, documentId, subjectId)` so a route rename cannot rot the archive), and
`notification_preferences` (a sparse override of code defaults, the `ai_settings`
relationship to `ASSISTANT_*` — an empty table means everybody gets everything).

## Deliberate deferrals

- **Email and webhooks.** The repo has no mailer; `en/notification.json` holds
  the password-reset text, which is logged rather than sent. Adding one would
  mean a new dependency and an SMTP server to verify against. A channel can be
  added later behind a provider token, the `ASSISTANT_PROVIDER` shape.
- **Workspace-level watch.** Document and project only. "Everything in this
  workspace" is a firehose, and it would need a mute-per-subject escape hatch to
  stay usable.
- **MCP tools.** An inbox has an addressee and stdio has no principal — the same
  reason there is no `knowledge_start_agent_run`.
- **Digests.** Coalescing already collapses the repetition a digest exists to
  hide, so there was nothing left for one to do.

## Verification

`make check`, then against the real database (all pass):

- a watcher is told, the actor is not; three edits to one page coalesce into one
  row carrying `count: 3`;
- `revision.indexed` and `connector.link.*` never reach the database;
- a read row is not coalesced into — the next event opens a fresh one;
- a project watch reaches a page inside it, and a mute on that page overrides it;
- muting `document`+`comment` still lets a mention through; muting `mention`
  suppresses it;
- an assignment on the non-notifiable `merge-request.updated` files under
  `review`;
- a mention of a non-member notifies nobody; watching a page from another
  workspace is refused;
- an addressed frame reaches its recipient's SSE stream and neither a peer's nor
  an unidentified one, while ordinary broadcasts still reach everyone;
- a mention posted through `DocumentThreadsService` notifies the person,
  subscribes the commenter as `participant` and the mentioned person too.
