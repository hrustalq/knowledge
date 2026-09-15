# 08 — The event bus: SSE, WebSocket, live cache

## What this is

One Redis pub/sub channel carries every fact the platform produces —
`knowledge:events` — and two API surfaces fan it out to browsers: an SSE
endpoint that a session opens once, and a WebSocket gateway that a client
subscribes to per workspace with a tracking configuration. On the browser side
those events drive the vue-query cache directly: some are shallow-merged into
cached entities, the rest mark query keys stale.

Delivery is best-effort by design. There is no replay, the UI refetches on
navigation, and a lost event therefore costs a moment of staleness rather than
correctness. Everything below follows from that.

The product-level description of the first half lives in
[../features/04-dependent-reindex.md](../features/04-dependent-reindex.md);
notification fan-out, which hangs off the same publish call, is
[../features/22-notifications.md](../features/22-notifications.md).

## The module split is the whole safety story

Three modules, because the publish side and the subscribe side have different
homes ([01-entrypoints-modules.md](01-entrypoints-modules.md)):

| Module                   | Holds                         | Loaded by                          |
| ------------------------ | ----------------------------- | ---------------------------------- |
| `EventsModule`           | `EventsPublisher`             | API **and** worker — publisher only, so it is worker-safe |
| `EventsSubscriberModule` | `EventsSubscriber`            | whoever needs to listen; exported, so one connection is shared |
| `EventsApiModule`        | `EventsController` + `LiveGateway` | `AppModule` only                   |

`EventsApiModule` exists for the reason `GraphQueryModule` and
`IngestionAdminModule` exist: a controller and a gateway with auth dependencies
must never be instantiated in the worker or MCP context. `EventsModule`
deliberately does **not** import `EventsSubscriberModule` — a process that only
publishes should not open a subscriber connection.

`EventsSubscriberModule` was carved out later, after `EventsSubscriber` turned
out to be listed as a bare provider in both `EventsApiModule` and
`WorkflowWorkerModule` and exported by neither: each context built its own
Redis connection and neither could be reached from elsewhere. One module, one
instance, one connection — the `AssistantClientModule` treatment.

`EventsModule` imports `NotificationsCoreModule` outright rather than behind a
`forwardRef`, and that is a constraint to preserve: `NotificationsService` takes
`PrismaService` and nothing else, so there is no cycle. A dependency there that
reached back for `EventsPublisher` would create one.

## Publish is the single injection point

`EventsPublisher.publish` is the one function every event passes through —
`ActivityService.record` on the API side, and the ingestion, workflow, agent,
import and connector processors on the worker side. That is why the per-person
notification fan-out hooks here rather than at those call sites, the same
"single injection point" reasoning `GraphService` uses for its mandatory
workspace predicate.

Two details of the publisher are deliberate. The Redis client is built with
`maxRetriesPerRequest: 1` and `connectTimeout: 2_000`, because `publish` sits in
request paths through `ActivityService.record` and ioredis's default twenty
reconnection attempts would hold a user's request hostage to a down Redis; the
offline queue stays **on**, since with `lazyConnect` the first publish is what
opens the connection. And the notification fan-out runs strictly _after_ the
broadcast: an inbox write must not be able to delay or swallow the live update
everyone else is waiting for.

`ActivityService.record` forwards `subjectId` and an optional `patch` — changed
entity fields — onto the bus without persisting the patch to the feed.
`document.updated` is the event that carries one today, and it is what makes
instant cache patching possible on the client.

## The SSE feed

`GET /v1/events?workspaceId=` is a `@Sse()` route carrying `@Access('viewer',
'query')`. `EventsSubscriber` holds one Redis subscriber connection per process
and fans it into an in-process RxJS `Subject`; `stream(workspaceId, userId)`
filters that subject by workspace, drops frames addressed to somebody else (see
below), and merges in a 30-second `{ type: 'ping' }` heartbeat so proxies do not
close an idle connection.

`EventSource` cannot set headers, so `AuthGuard` also accepts `?token=` — the
same accommodation `<img>` tags need for attachments.

Two ordering rules inside the subscriber are load-bearing and were both bugs
first. The `message` listener is registered **before** the subscribe and outside
the try block, or a rejected subscribe skips it entirely. And a failed _first_
subscribe is retried by hand on `ready`, because ioredis only auto-resubscribes
a channel it has already subscribed to successfully — so when Redis is not up
yet at boot, ordinary container start ordering, nothing ever reattaches and the
process stays deaf for its whole lifetime behind a single boot-time warning: no
SSE, no WS frames, no workflow triggers.

On the browser, `stores/events.ts` opens one `EventSource` per session and does
the coarse work: toasts on `revision.indexed|failed|dependent-reindex`,
refreshes the notification badge on `notification.created` (toasting only when
`reason === 'mention'`), reconciles the assistant on
`assistant.turn.finished`, and invalidates the documents store on
`document.*` / `merge-request.*`.

## The dependent-reindex cascade

The worker publishes the revision lifecycle — `revision.indexed`,
`revision.failed`, `revision.dependent-reindex` — and, on a successful index,
fans out **one level** of re-indexing:

1. entities this document points at with `DESCRIBES` edges (what it defines);
2. other documents carrying any relation edge to those entities — the
   dependents;
3. for each, up to `DEPENDENT_REINDEX_MAX` (default 20), a `reindex`
   `ingestion_jobs` row for its default-branch head, skipping heads that already
   have a `queued` or `running` job.

Loop protection is a flag on the payload: cascade jobs carry
`payload.reason = 'dependent-reindex'` and the processor does not cascade from
such a job. One level per user-triggered index, no transitive storms. The
enqueue itself is non-fatal — the `OutboxSweeper` re-enqueues anything left
`queued`, which is the point of the outbox — but a failure is logged loudly,
because "the sweeper will pick it up in a moment" and "every enqueue is failing"
are otherwise indistinguishable, the second presenting only as unexplained
indexing latency with nothing to grep for.

## Why the WS gateway authenticates itself

`/v1/events/ws` is a `@nestjs/platform-ws` gateway
(`apps/api/src/events/live.gateway.ts`), with `WsAdapter` installed in
`main.ts`. It speaks the strict `LiveClientMessage` / `LiveServerMessage`
protocol from `@knowledge/contracts` — raw JSON frames, not
`@SubscribeMessage`'s `{event,data}` envelope, so a browser client can send
plain objects.

**`APP_GUARD`s never run on a WS upgrade.** That single fact shapes the file:

- Authentication is done by the gateway, using `TokenAuthService` — extracted
  out of `AuthGuard` and exported by the global `AuthModule` precisely so both
  paths apply the same rules (`AUTH_MODE=none` → dev principal; `ks_` sessions
  and `kn_` API keys otherwise, disabled users refused on both). Bearer header
  or `?token=`, mirroring SSE.
- A failure sends an `ApiErrorPayload` frame — the same envelope as HTTP, see
  [07-api-client-errors.md](07-api-client-errors.md) — and then closes with
  **4401**. A disabled gateway (`LIVE_WS_ENABLED=false`) answers 503 and closes
  4503.
- Middleware never runs either, so the socket's language is resolved once from
  the upgrade request and every message handled inside `withLocale`, and each
  message opens its own trace scope: a message is the unit of work a request
  would have been.

A 30-second ping/pong heartbeat terminates sockets that stop answering.

## Access control, then tracking

The two filters are separate and neither substitutes for the other.

**Access control.** Every `subscribe { workspaceId, tracking }` runs
`AccessService.requireRole(principal, workspaceId, 'viewer')` against Postgres
_before the subscription exists_ — the same deny-by-default stance the graph
layer takes. `fanOut` then skips any socket with no subscription for the event's
workspace, so an unsubscribed workspace is never merely filtered late, it is
never delivered.

**Tracking** is configuration, two-layered and intersected:

- server side, `LIVE_TRACKED_EVENTS` (comma-separated, exact types or
  `prefix.*` globs, `*` by default) is checked once per event before any socket
  is considered;
- client side, each subscription may narrow further with `events` (≤ 64
  patterns) and `documents` (≤ 256 ids). Absent or empty means "everything I may
  see".

`LIVE_WS_MAX_SUBSCRIPTIONS` (default 8, max 64) caps workspaces per socket.
`EventsSubscriber.all()` gives the gateway the unfiltered firehose from the one
upstream Redis subscription; all per-socket work happens in `fanOut`.

One more filter belongs to neither layer: an event carrying `userId` is
_addressed_, and both fan-out sites — `EventsSubscriber.stream` and
`LiveGateway.fanOut` — drop it for everyone else. Without that, a
`notification.created` published onto a workspace-wide bus would tell every peer
who is being notified about what.

## The client: LiveClient and the live cache

`apps/web/src/api/live.ts` holds `LiveClient`: connect, replay every desired
subscription on open, exponential backoff from 1s to 30s on close — except
**4401**, where reconnecting with the same token is pointless and it stops.

The dev-mode detail worth knowing: the client connects **straight to
`ws://localhost:3000`**, because the Vite middleware proxy does not upgrade
WebSocket connections. `VITE_WS_URL` overrides; in production it derives
`wss://<host>/api` from the page.

`live-cache.ts` binds events to the query cache through rules that are data, not
code paths. Each `LiveCacheRule` matches an event type (exact or `prefix.*`) and
may:

- **patch** — `document.updated` carries `event.patch`, which is shallow-merged
  into every cached query whose key starts `/v1/documents/{` and whose path
  params name that document (merging into `record.document` where the response
  nests it). Instant, no network.
- **invalidate** — everything else maps to query-key prefixes and lets vue-query
  refetch only what is actually on screen.

`defaultLiveCacheRules` covers the whole vocabulary — documents, page comment
threads, revisions, merge requests, workflow runs and nodes, agent runs,
connectors, projects, relations, notifications — with a final `*` rule
refreshing the activity feed. Two conventions recur: `subjectId` carries the
secondary subject (merge request id, run id) and is what the detail keys are
built from, and where a prefix is ambiguous — `connector.*` uses `subjectId` for
a connector id on run lifecycle events and a run id on staging events — both
readings are invalidated, since a key nobody holds costs nothing and a key built
from the wrong id silently never matches.

`startLive({ queryClient, tracking?, rules?, workspaceId? })` is the idempotent
bootstrap, called from `App.vue` beside the SSE store once the user is
authenticated; calling it again retunes the subscription live.

## Optimistic writes

`useApiMutation(method, url, { patches, invalidates })` in
`apps/web/src/api/queries.ts` is the write-side counterpart, and its contract is
fixed: **cancel in-flight queries on the patched keys → snapshot → patch →
roll back the snapshots on error → invalidate on settle**, so server truth
always wins in the end. Patched keys are always invalidated; `invalidates` adds
more.

Live WS patches landing mid-flight are safe rather than a race: they carry
server truth for the same keys, and the settle-time invalidation is the
backstop either way.

## Limits

Best-effort delivery, no replay for a reconnecting client (Redis streams were
noted as future work in feature 04), and only one level of dependent re-index —
transitive cascades would need a depth budget and cycle detection.

`KNOWN_EVENT_TYPES` in contracts is the subscription vocabulary — it backs
`LIVE_TRACKED_EVENTS`, the WS `subscribe` filter and the workflow trigger
picker — but **it drifts in both directions and nothing catches it**:
`publish()` is unchecked and `KnowledgeEvent.type` is a plain string, so a type
can be declared with no producer or produced with no declaration, the latter
silently unsubscribable since a filter can only match what is listed. The fix
would be an event registry keyed on a closed union; until then, audit with a
grep for `publish(` and `record({ action:` before trusting the list.
