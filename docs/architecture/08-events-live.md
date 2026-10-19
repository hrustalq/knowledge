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

`EventSource` cannot set headers, so the route is marked `@QueryTokenOk()` and
`AuthGuard` accepts `?token=` on it. No other HTTP route reads a query token
(#102; `<img>` asset routes read the session cookie instead). The token is a
single-use `kt_` ticket from `POST /v1/auth/url-ticket` (a `kn_` key or `ks_`
session in a URL is refused), so `stores/events.ts` reconnects by hand with a
fresh ticket rather than relying on `EventSource`'s own retry.

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

## The second gateway: `/v1/collab`

Co-editing ([feature 56](../features/56-realtime-coediting.md)) runs a second
`@WebSocketGateway` on the same `WsAdapter` and port. It shares none of the
above protocol: it hands each socket to an embedded Hocuspocus, which speaks
binary y-protocols frames and multiplexes documents. What it shares is the
stance:

- **It authenticates itself**, per document: only a single-use `kt_` ticket is
  accepted (no `ks_`/`kn_` in a socket URL), and page permissions decide view
  or edit. Outcomes are per-document reasons, not close codes; the only close
  code is 4503 with `COLLAB_ENABLED` off. `LIVE_WS_ENABLED` does not switch it
  off.
- **CRDT traffic never rides `knowledge:events`.** Updates and awareness go
  between instances through `@hocuspocus/extension-redis` on its own
  connections (`kn:collab` prefix). The bus carries only the two things a
  page needs to *react* to, `draft.changed` and `draft.reset`. Both are
  deliberately outside `document.*`, so an editor joining does not reload the
  page, toast, or offer a workflow trigger.
- **`acl.changed` re-judges open connections** of that workspace, exactly as
  it narrows a `/v1/events/ws` subscription, plus a
  `COLLAB_REAUTH_INTERVAL_SECONDS` sweep for role changes, which have no event.
- **A lost `draft.reset` heals itself.** Each instance closes its own peers on
  the event, and a store from a doc loaded before the reset is refused and
  closes them anyway.

## Access control, then tracking

The filters are separate and none substitutes for another.

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

**Page visibility** (#76) sits after the workspace check and before tracking.
A frame about a page reaches only the connections whose holder can open it.
`LiveVisibility` (`events/live-visibility.ts`) makes that call for both fan-out
sites, so SSE and WS cannot disagree:

- Each connection's `AccessScope` is cached for `ACL_CACHE_TTL_MS`. A frame is
  not a request, and three PG reads per frame per socket would turn the bus into
  a load test.
- `acl.changed` drops every cached scope for its workspace before the next frame
  is judged, then goes out to clients as an ordinary frame. It names no page,
  and the web refetches the tree and search on it. `AclEventsService` publishes
  it after a change to the access dialog, group membership or a group, an
  approval, or a connector's mirrored grants (at most once a second per
  workspace).
- A page's chain is read once per frame, and only when some listener's scope
  hides anything. In a workspace with no restrictions the filter costs nothing.
- It denies by default. A scope that cannot be computed delivers nothing about
  pages, and a page that cannot be read (deleted) reaches only those who see
  everything. Workspace-level frames and addressed frames pass unchanged.

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

A connection that misses `acl.changed` (a Redis blip) may keep receiving frames
about a page it just lost for up to `ACL_CACHE_TTL_MS`. Those frames carry ids
and event types, not content, and every request it makes still reads PG.

Best-effort delivery, no replay for a reconnecting client (Redis streams were
noted as future work in feature 04), and only one level of dependent re-index —
transitive cascades would need a depth budget and cycle detection.

Two server-side listeners accept that loss rather than work around it, and
say so in their docs ([../features/49-agent-triggers.md](../features/49-agent-triggers.md#where-it-runs)):
`AgentTriggerListener` (worker, behind `AGENT_TRIGGERS_ENABLED`) starts agent
runs from four bus types, and `RepoGuidanceListener` (API) imports a
repository's guidance files after `connector.run.succeeded`. Both subscribe
through `EventsSubscriber.all()`, so neither opens a connection of its own. An
event published while the listening process is down starts nothing: a trigger
is a convenience over an event, not a queue, and the guidance import catches up
on the next sync or on **Import now**. Neither hears an `agent.*` event, which
is what keeps an agent run from triggering itself.

Where a missed event is a correctness problem, the reader does not use the
bus. Chat-bot channel notifications ([../features/47-chat-bots.md](../features/47-chat-bots.md#channel-notifications))
read `activity_log` past a per-rule cursor instead: `ActivityService.record`
writes the row before it publishes, so the table holds everything the bus
carried that the feed records, and a restart resumes where the cursor stopped.
That cursor has to step around two things the bus never shows: rows stamped
earlier that commit later (a few seconds of lag), and a page's tags reaching
the graph only once it is indexed (the cursor holds before such a row).

`KNOWN_EVENT_TYPES` in contracts is the subscription vocabulary — it backs
`LIVE_TRACKED_EVENTS`, the WS `subscribe` filter and the workflow trigger
picker — but **it drifts in both directions and nothing catches it**:
`publish()` is unchecked and `KnowledgeEvent.type` is a plain string, so a type
can be declared with no producer or produced with no declaration, the latter
silently unsubscribable since a filter can only match what is listed. The fix
would be an event registry keyed on a closed union; until then, audit with a
grep for `publish(` and `record({ action:` before trusting the list.
