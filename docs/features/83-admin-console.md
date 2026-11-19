# 83 — Platform admin console

Milestone [#1235](https://github.com/hrustalq/knowledge/issues/1235). A separate web app for running the
platform: configuration, monitoring, users and errors. Workspace settings keep workspace things.

| Phase | Issue | PR | What landed |
| --- | --- | --- | --- |
| 1 | [#1236] | [#1275] | `apps/admin`, its image and route; the platform-admin gate; `@knowledge/api-client` |
| 2 | [#1237] | [#1276] | The configuration view: `GET /v1/admin/config` |
| 3 | [#1238] | [#1277] | Monitoring: `GET /v1/admin/health`, `GET /healthz`, heartbeats and sweeper ticks |
| 4 | [#1239] | [#1278] | Users: the roster, one account's page, `user.*` audit actions; Accounts leaves `/settings/access` |
| 5 | [#1240] | [#1283] | Errors over `ops_events`: `GET /v1/admin/errors`, a `process` column, `OPS_EVENTS_RETENTION_DAYS` |

[#1236]: https://github.com/hrustalq/knowledge/issues/1236
[#1237]: https://github.com/hrustalq/knowledge/issues/1237
[#1238]: https://github.com/hrustalq/knowledge/issues/1238
[#1239]: https://github.com/hrustalq/knowledge/issues/1239
[#1240]: https://github.com/hrustalq/knowledge/issues/1240
[#1275]: https://github.com/hrustalq/knowledge/pull/1275
[#1276]: https://github.com/hrustalq/knowledge/pull/1276
[#1277]: https://github.com/hrustalq/knowledge/pull/1277
[#1278]: https://github.com/hrustalq/knowledge/pull/1278
[#1283]: https://github.com/hrustalq/knowledge/pull/1283

## The app and its door

`apps/admin` is a client-only Vite SPA built for the `/admin/` base and shipped as its own image
(`Dockerfile.admin`: static files behind Caddy, strict CSP, `/healthz`). The front `Caddyfile` routes
`/admin` and `/admin/*` on the app's own host to it, so the member app's HttpOnly session cookie reaches it.
There is no second sign-in: a signed-out visitor goes to the member app's `/login?redirect=/admin/…`, and
`LoginPage` / the SSO completion follow a return path into the console with a full load (`isOtherApp`),
because the member app's router cannot push there.

The router renders nothing until `GET /v1/me` answers. A platform admin (`users.is_admin`) or the dev
principal gets the console. Anyone else, a workspace admin included, gets the 403 page, and the console
calls no other route. A failed check shows a retry. This gate only keeps a non-admin from an empty console:
**the API is the door**, and every `/v1/admin/*` route carries `@PlatformAdmin()`, enforced in `AclGuard`.

The console is laid out in `apps/web`'s layers (`app → modules → entities → stores → shared`,
[architecture 11](../architecture/11-web-modules.md)) with the same dependency-cruiser layer rules. It shares
code with the member app only through packages: `@knowledge/ui`, `@knowledge/contracts` and
`@knowledge/api-client` (the generated schema, the typed request core, the error helpers and the vue-query
builders). `web-imports-no-admin` and `admin-imports-no-other-app` hold the boundary, so nothing of the
console ships in a member's bundle.

Locally, `make dev` serves it on :5174 and `apps/web`'s Vite proxies `/admin` to it. Open
`localhost:5173/admin`, where `/login` works. In production it needs the homelab `admin` Deployment
([#1274](https://github.com/hrustalq/knowledge/issues/1274)); until then `/admin` answers 404.

## Configuration

`GET /v1/admin/config` answers `AdminConfigResponse`: every key of `envSchema`, in schema order, as **this
API process** resolved it. Workers, the learner and the git remote resolve their own environment, and the
page says so rather than pretending to speak for them.

Each entry carries:

- **`group`**: derived from the key's name by `envGroupOf` (`config/env-report.ts`), longest prefix wins
  (`AI_READABLE_` is publishing, `AI_` is AI). Never stored. A spec fails when a key lands in `other`, so a
  new prefix joins the table.
- **`source`**: `env` when the environment set the key, `default` otherwise. `validateEnv` records the keys
  it was given (`providedEnvKeys`), because nothing later can tell: `@nestjs/config` writes the validated
  values, defaults included, back into `process.env`. An injected production default
  (`AUTH_REQUIRE_VERIFIED_EMAIL`) reads `default`.
- **`value`**: the effective value, or null. **A secret never has its value returned**, only `set`.
  `SECRET_ENV_KEYS` is the one list, and the DSNs are on it, because a password can sit in a query string.
  `env-report.spec.ts` fails when a key whose name matches `/SECRET|TOKEN|KEY|PASS/` is in neither it nor
  `NOT_SECRET_ENV_KEYS`. Every other URL value has its userinfo stripped on the way out.

The page lists the groups with a search over keys and (non-secret) values and an "only keys the environment
sets" filter. It is read-only: env is owned by the k3s manifests and the GitHub production environment.

## Monitoring

`GET /v1/admin/health` (`AdminHealthService`, `admin/admin-health.service.ts`) answers `AdminHealthResponse`,
read fresh on every call, never cached: a cached "up" is the one answer a monitor must not give. Each part fails
on its own, so a down Redis still shows the stores.

- **Stores.** One probe per dependency, each bounded by a 2 s timeout that also aborts its request: PostgreSQL
  (`SELECT 1`), Redis (`PING`), MinIO (`StorageService.ping`, a HeadBucket), ArcadeDB (`GraphService.ping`, so
  the one graph injection point stays the only caller of `ArcadeClient`), OpenSearch when
  `FULLTEXT_PROVIDER=opensearch` (`/_cluster/health`) and SearXNG when `WEB_SEARCH_URL` is set (`/healthz`). An
  unconfigured one is `off`, not probed. An error's URL credentials are stripped (`scrubCredentials`).
- **Queues.** `MONITORED_QUEUES` names every BullMQ queue; `admin-health.spec.ts` fails when a
  `BullModule.registerQueue({ name })` is missing from it. Counts come from the `Queue` the API already holds as a
  producer (looked up through `ModuleRef`), so a read opens no connection. A queue the API does not register gets
  its own, kept for the process. The shared `SharedRedis` client cannot be handed to BullMQ: the app runs ioredis 6,
  BullMQ ioredis 5. `waiting` folds in BullMQ's `paused` and `prioritized` lists, which an operator reads as waiting.
- **Processes and ticks.** `OpsBeaconModule.forProcess(kind)` (`observability/ops-beacon.ts`) is imported by the
  four long-running entrypoint modules (`AppModule`, `WorkerModule`, `LearnerModule`, `GitModule`), never by
  `BootstrapModule`, which also boots the OpenAPI generator and the MCP stdio process. It writes a heartbeat every
  15 s into the hash `ops:processes`, and installs the one process-wide tick recorder (`reportTicksTo` in
  `common/ticker.ts`). `Ticker.exclusive` reports every finished pass (name = the owner's `Logger` context, its
  interval from `every`, ok, duration) into `ops:ticks`; a busy pass reports nothing. Hashes rather than a key per
  entry, so a read is two `HGETALL`s instead of a keyspace `SCAN`. Fields have no TTL, so `readBeacons` prunes
  on read: a process silent for 5 min, a tick silent for a day. An instance is live within 60 s. A tick is late
  after three intervals plus a minute. The API and the worker are always expected; the learner and the git remote
  only while `LEARNER_ENABLED` / `GIT_REMOTE_ENABLED` are on.

`GET /healthz` (`AppController`, `@Public()`, excluded from the OpenAPI document) answers `{ "status": "ok" }`
and touches no store: it is liveness, so a down dependency never restarts the pod, and it tells a stranger
nothing. Not `/health`: that path is the Hindsight memory wire's ([80](80-memory-banks.md)), which also pins
`/health/live` and `/health/ready` as 404s. Pointing the k3s probes at it is a homelab change ([#1274](https://github.com/hrustalq/knowledge/issues/1274)).

The page polls every 10 s while the tab is visible. Status is a 6px dot plus a word in the panel ramp (tip up,
caution down or failed, warning late), never emerald/amber/red, which the indexing dot owns. The ramp moved
from `apps/web`'s `editor.css` into `@knowledge/ui`'s `tokens.css` / `theme.css` for this, so both apps (and
the export renderer, which inlines `tokens.css`) read one declaration. Problems counted in the summary are down
stores, expected processes with nothing live, and failed or late ticks, which sort first. A queue's failed
count is shown in caution ink but not counted, because BullMQ keeps failed jobs and it would never clear.


## Users

The console's Users section replaces the Accounts tab that sat on the member app's `/settings/access`: who has an
account is the platform's question, not a workspace's. `/settings/access` keeps members, roles, groups and
requests, and shows a platform admin an **Accounts** link into the console (a plain link: another app, a full
load). `/settings/users` redirects to `/settings/access`.

- **The roster, `/users`.** `GET /v1/users` (`UsersController`, `@PlatformAdmin()` on the class), one response
  for every account. Each `UserSummary` gains `lastSignInAt`, the newest `sessions.created_at` (one `groupBy` per
  list, derived and never stored; a revoked or expired session still counts as a sign-in), and each membership
  gains `workspaceName`. A deleted workspace's memberships are left out. Filters (status, role, workspace, name
  or email) match client-side, and the workspace filter's options come from the memberships, so the page makes
  one call.
- **One account, `/users/:id`.** Read from the same roster query, so there is no per-user route. Actions are what
  `v1/users` already did: rename, set password (a dialog, not `window.prompt`), make or revoke platform admin,
  disable or enable, and the sessions with **Sign out everywhere**. Making an admin and disabling ask first. On
  your own page the admin and disable buttons are off, because the API refuses both. Memberships are read-only
  here: a role is changed from that workspace's Access page by whoever manages it.
- **Audit.** Every account write records one row per kind of change, `workspaceId` null and `target` the user:
  `user.created` (`invited`, `isAdmin`), `user.renamed` (`from`, `to`), `user.admin_granted`,
  `user.admin_revoked`, `user.disabled`, `user.enabled` and `user.password_set`. `accountChanges`
  (`users.service.ts`) writes a row only for a field whose value changed, and never the password. Session revokes
  stay `auth.session_revoked`.

The session rows (`SessionList`, `describeUserAgent`) moved from `apps/web` into `@knowledge/ui/session-list`, so
the profile page and the console draw a session the same way. The kit keeps Intl out (its lint), so the list
takes a `when` formatter. The Intl formatters both apps need (`formatRelative`, `formatDateTime`,
`formatDuration`, …) are now `@knowledge/contracts/format`, taking an explicit locale. `apps/web`'s
`shared/utils/format.ts` wraps them with the app's locale, and Monitoring dropped its inline copies.

## Errors

`ops_events` has been written since the observability work (`OpsSinkService`: every `error`/`fatal` log, buffered
and flushed every 2 s, while `OPS_SINK_ENABLED` is on) and nothing read it. The Errors section is its reader.

- **The list, `/errors`.** `GET /v1/admin/errors` (`AdminErrorsController`, `@PlatformAdmin()`) returns groups,
  newest last-seen first, 50 a page with a keyset cursor (`last_seen` to the microsecond + fingerprint, so a
  page boundary never repeats or skips a group). Filters run in SQL: a period (`hours` 1, 24, 168 or 720, a pinned
  scope on the bar), process, workspace, and text that matches the message (contains) or a trace id (exact).
  The workspace options are the period's workspaces with errors, returned beside the groups. A group's count and
  first seen cover the period; the error's own page counts everything still kept.
- **The fingerprint is derived, never stored** (`FINGERPRINT_SQL`, `admin-errors.service.ts`, the one spelling):
  md5 of source, the logger context (`fields.ctx`) and the message plus the logged error's own type and message,
  with uuids, quoted values and numbers folded. The error's own text is in it because a catch-all logs one
  sentence for everything (`ApiExceptionFilter`: "Unhandled exception"), which alone made every 500 one group.
  The list shows that text under the message as `detail`. A better rule regroups history on the next read.
- **One error, `/errors/:id`.** `GET /v1/admin/errors/:id`: trace id (with a copy button), process, source,
  logger, route, code, duration, workspace and user, the stack (`fields.err.stack`), every logged field, and the
  group's 20 newest occurrences. The group read filters on source and context before the regex, which the
  fingerprint starts with.
- **Which process.** `ops_events.process` (nullable, migration `20270207100000_ops_events_process`, with a
  `created_at` index) is stamped by the sink from `stampOpsProcess`, which `OpsBeacon` calls in its constructor,
  so only the four long-running entrypoints write one. Rows from before the column, and from the MCP stdio
  process or a script, show "Not recorded". A row written outside any request or job context has source `cli`.
- **Retention.** `OpsRetentionSweeper`, provided by `WorkerModule` so one process sweeps, deletes rows older than
  `OPS_EVENTS_RETENTION_DAYS` (default 30) once an hour, 5,000 at a time, at most 20 batches a pass. None existed
  before. When `OPS_SINK_ENABLED` is off the response says `recording: false` and the page says that an empty
  list proves nothing.

