# 06 — Auth & ACLs

Two guards, resolved in PostgreSQL before a handler runs. Authentication says who
you are; authorization says which workspace you may touch, and it is answered
_before_ any graph or storage query is issued.

## What this is

`AUTH_MODE` switches the whole posture:

| Mode               | Behaviour                                                       |
| ------------------ | --------------------------------------------------------------- |
| `none` _(default)_ | Every request is a synthetic **dev principal** with full access |
| `api-key`          | `Authorization: Bearer` resolved against sessions or API keys   |

`none` is what keeps the demo and local web flows working with no signup. It is
also why **ACLs cannot be tested in dev mode** — bootstrap a key instead
(`make auth-bootstrap email=…`).

The dev principal's userId **is** the zeros `AUTHOR_ID_STUB`. That single fact
propagates into several deliberate accommodations elsewhere: merge approval gates
skip it (self-approval exclusion would otherwise deadlock every dev merge, see
[05](05-merge-review.md)), and notification actor-suppression skips it (every
request is the same principal, so suppressing it would leave the inbox
permanently empty).

## The two guards

`AuthModule` is `@Global()` and registers both as `APP_GUARD`. **Provider order
is execution order**: `AuthGuard` → `AclGuard`.

1. **`AuthGuard`** resolves the principal, or 401. `@Public()` opts a route out
   (signup, login, forgot/reset password). A `?token=` query credential is read
   **only on routes marked `@QueryTokenOk()`**, because `EventSource` and
   `<img>` cannot set headers: the SSE stream and the attachment, import-image
   and avatar redirects. Anywhere else the query token is ignored as if absent,
   so the request is a 401 (#102). `test/query-token.spec.ts` pins that list,
   so a new route cannot opt in without a reviewed spec change. Query values
   named `token` are masked in the API's request and error logs
   (`redactUrl`) and in the bundled Caddy access log.

   What a query token may **be** is narrower than a header (#102, phase 2,
   `TokenAuthService.resolveQueryToken`): a single-use `kt_` URL ticket or a
   `ks_` session token. A `kn_` API key in a URL is a 401 even on an opted-in
   route, because it lives until revoked. A caller that needs the SSE stream
   mints a ticket first with `POST /v1/auth/url-ticket` (header credential
   only; `@ReadKeyOk`) and puts that in `?token=`. `test/url-tickets.spec.ts`
   pins the rules.

2. **`AclGuard`** reads `@Access(role, source)` metadata, resolves the target
   **workspace in PostgreSQL**, and 403s on failure.

**Status codes are a convention worth keeping: 401 is always `AuthGuard`, 403 is
always `AclGuard`/`AccessService`.**

`source` names where the workspace is found — `body`/`query` carry a
`workspaceId` field, while `document`, `merge-request`, `job`, `workspace`,
`project`, `glossary-term`, `connector`, `saved-filter` and the rest resolve a
`:id` param to its owning workspace. A resource id from another tenant therefore
**403s before the handler sees it**.

Two consequences:

- **A new route without `@Access` is authenticated-only with no workspace
  check.** This is the single easiest security mistake to make in this codebase.
- **A route with no single workspace to resolve cannot use `@Access`.** Write an
  explicit assertion instead — `GET /v1/users/:id/avatar` uses
  `assertCanSeeUser`, which asks in one indexed query whether the caller shares
  _any_ workspace with the subject. "Any authenticated caller" would let one
  tenant enumerate another's people.

Saved filters forced the first non-uuid param parse: `intId()` beside `uuid()`,
because that resource is keyed by an autoincrementing integer
([05](05-merge-review.md)).

## Roles

`guest < viewer < editor < admin`, held in `workspace_members`
(`WORKSPACE_ROLES` in contracts), plus a separate **`trusted_operator`** flag
that is not a role — it gates the raw graph query and nothing else.

**`guest`** (issue #76) sits below the ladder at `ROLE_ORDER.guest = -1`, so
every `@Access('viewer', …)` route refuses one with no special case. A guest
reads only what is granted to them or their groups (see _Page restrictions_
below): they pass a `'document'`, `'merge-request'` or `'project'` route when the
page level covers it, and a workspace-level route only when it is marked
`@Access(…, { guests: true })`, which promises the handler filters its answer
by the caller's scope (the document list and tree, the project list). Code that
asks "is this person a member" directly rather than through `requireRole` —
mention recipients, page owners, members-only site audiences, the llms.txt hub,
MCP `whoami` — filters with `WORKSPACE_READER` (`auth/principal.ts`).
Notifications follow page visibility instead (below), so a guest is told about
the pages granted to them and nothing else.

**User groups** (`user_groups`, `user_group_members`) are workspace-scoped sets
of members that restrictions grant to. `source` is `manual`, `connector`
(mirrored by ACL sync) or `scim`; the API answers 409 to any edit of a
non-manual group, since the next sync would undo it. Members must already belong
to the workspace. `WorkspacesService.removeMember` deletes a person's group rows
and their page grants with their membership, and deleting a group deletes the
grants to it, so a re-added person or a reused id inherits nothing.

## Page restrictions

Issue #76, phase 2. The workspace is still the tenant boundary; below it a
**project or a page can be restricted**, with `view | edit | manage` grants to
people or groups (`access_grants`, no FK on subject or resource).

- **View is intersective down the chain** project → root → … → page. A reader
  must hold a grant on _every_ restricted node, so restricting a page hides its
  subtree and a child can narrow but never re-open. An empty table reproduces
  the old behaviour exactly: nothing restricted, nobody filtered.
- **The workspace role is the ceiling.** A viewer with an `edit` grant reads.
  Edit is decided by the nearest restricted node carrying any edit/manage grant;
  without one, `editor` edits as before. Manage (change restrictions) belongs to
  whoever edits until the chain names a manager, then only to holders of a
  manage grant — an editor may restrict an open page, and keeps it once they do.
- **Guests** reach only nodes with a grant on their chain, at no more than edit.
- **Workspace and platform admins bypass**, as they control membership anyway.
  A bypass read of something no grant admits them to writes `acl.bypass` into
  `audit_logs` (at most once a minute per admin and page).
- A read-only key caps every level at view.

The rule is one pure function, `levelOn` (`permissions/access-scope.ts`), used
by the guard, the access routes and `whoCanOpen` (reviewers).

**The visibility predicate is denormalized.** `documents.restricted_by` holds
the ids of every restricted node on the page's chain, outermost first.
`PermissionService.scopeFor(principal, workspaceId)` computes an `AccessScope`
once per request — `denied` (restricted nodes the caller holds no grant on) and
`granted` (nodes they hold any grant on) — and a page is visible iff
`restricted_by && denied` is empty (GIN index), plus, for a guest, a granted id
on its chain. It has three spellings — `canSee` (memory), `visibilityWhere`
(Prisma) and `visibilitySql` (raw) — kept adjacent and pinned against each
other in `test/permissions.spec.ts`. **Every service method that returns pages
takes a required `AccessScope`**, so a new call site cannot forget it.

`restricted_by` is rewritten only by `PermissionService.recomputeRestrictedBy`:
one statement over a subtree (left-anchored `path LIKE`) or a project, run inside
the transaction that created, moved or re-projected a page, flipped a switch or
deleted a project into another. Rows whose value is already right keep their
`acl_version`; changed rows bump it, and the worker's `AclRestampSweeper` copies
the new value onto the search stores' `aclNodes` stamps — see
[04](04-search-graph.md#page-restrictions).

**The guard checks the resource.** For `'document'`, `'merge-request'` (its
page) and `'project'` sources, `AclGuard` keeps the resolved id and calls
`PermissionService.requireResource`, mapping viewer→view, editor→edit,
admin→manage. A page the caller may not open is a **404 for a guest** and a
**403 `{ canRequestAccess, resourceType, resourceId }` for a member — never its
title**. MCP's `guard.doc/mr/project` call the same method.

Restricted pages never leave the workspace's own access model: a share link to
one is refused (409 `share.restricted`) and an existing one 404s; published
sites, llms.txt and the workspace/project listings carry only pages with an
empty `restricted_by`; exports hold what the requester may open, resolved again
in the worker from `requested_by`.

`users.is_admin` is a **platform** admin: it bypasses workspace ACLs entirely and
gates `@PlatformAdmin()` routes (`GET/POST/PATCH /v1/users`). **Self-disable and
self-de-admin are blocked** — the one thing a platform admin may not do is remove
the last way back in. `make auth-bootstrap` marks its user platform admin by
default.

`WorkspacesService` holds the matching invariant for workspaces: **the last admin
cannot be demoted or removed.**

### Who hears about what (#76, phase 5)

The same predicate reaches the per-person surfaces:

- **Notifications.** `NotificationsService.deliver` keeps a recipient only if
  `whoCanOpen` admits them to the event's page, or project. An event about
  neither (a run, an import) still skips guests. `whoCanOpen` and
  `resolveChain` live as plain functions in `permissions/acl-read.ts`, because
  `NotificationsService` may not inject `PermissionService`: the permission
  module publishes through `EventsModule`, which imports notifications. A
  mention of someone who cannot open the page notifies nobody, and the thread
  routes return them in `mentionedWithoutAccess`. The answer to someone's own
  access request is the one row sent with `requireAccess: false`, and it carries
  no title.
- **Activity.** `ActivityService.list` and `calendar` take the caller's
  `AccessScope` and pick rows in SQL: `NOT EXISTS` a hidden page for a member,
  `EXISTS` a visible page for a guest. They page by `(created_at, id)` with the
  same cursor as before. A row about a deleted page stays visible, as it did.
- **Live events.** `LiveVisibility` (`events/live-visibility.ts`) is shared by
  the SSE stream and the WS gateway. It caches each connection's scope for
  `ACL_CACHE_TTL_MS`, reads a page's chain once per frame and only when some
  listener's scope hides anything, and judges frames in order. `acl.changed`,
  published by `AclEventsService` from the access dialog, group membership
  edits and approvals, names no page. It clears the cache and tells clients to
  refetch.
- **Access requests** (`access_requests`, `AccessRequestsService`). Approving
  grants the decided level on every restricted node on the chain that the
  requester lacked a grant on (`grantTargets`), because view is intersective.
  The approver must manage each of those nodes. Managers to notify are the
  holders of manage grants on the chain plus the workspace admins. A partial
  unique index allows one pending request per person and node. Expiry is a
  due check in the API's `AccessRequestSweeper` tick.

## Credentials

Everything is hashed; nothing reversible is stored.

| Secret        | Prefix | Storage                                                                            |
| ------------- | ------ | ---------------------------------------------------------------------------------- |
| Password      | —      | **scrypt** via `node:crypto`, no dependencies                                      |
| Session token | `ks_`  | SHA-256 in `sessions`                                                              |
| API key       | `kn_`  | SHA-256 in `api_keys` (many per user)                                              |
| Reset token   | `kr_`  | SHA-256, single-use, TTL `AUTH_RESET_TTL_MIN` (an invite: `AUTH_INVITE_TTL_HOURS`) |
| Verify token  | `kv_`  | SHA-256 + the address it was sent to, single-use, TTL `AUTH_VERIFY_TTL_HOURS`      |
| URL ticket    | `kt_`  | SHA-256 key in Redis, `GETDEL` on use, TTL `AUTH_URL_TICKET_TTL_SEC` (60 s)        |

API keys are **shown once** — at bootstrap, or on Settings → Connect AI — and
never retrievable. A key may be **read-only**, **pinned to one workspace**, or
**expiring**; that narrowing rides on the principal (`principal.apiKey`) and is
enforced inside `requireRole`, ahead of the platform-admin shortcut, so it can
only ever take rights away. A read-only key is also refused any non-GET route
without `@Access` unless the route is `@ReadKeyOk()` (only `POST /v1/mcp`). Keys
are managed from a session only — never with another key.

A third scope, **`capture`** (#73, [features/50](../features/50-agent-memory.md)),
is read-like everywhere except on calls flagged `{ capture: true }`. On those it
passes up to `editor` and never past it. The flag rides through
`requireRole(…, { capture })`, `PermissionService.requireResource(…, { capture })`,
`@Access(role, source, { capture: true })` and the MCP guards
`guard.captureWs` / `guard.captureDoc`. Only the capture tools,
`POST /v1/captures` and `POST /v1/assistant/messages/:id/capture` set it. Approve,
reject, merge and approving a merge request do not, so what proposes a capture
can never decide it. On a flagged page call, `requireResource` lifts the key's
page level from view-capped to the person's own. A capture key may carry a
project pin (`api_keys.project_ids`). Only capture keys accept one, and it
narrows where the key may capture, not what it reads. `CaptureService`
enforces it. A stored scope is parsed fail-closed by `apiKeyScopeOf`: an
unknown value reads as `read`, never `write`. For the `AclGuard` rule on
unscoped non-GET routes, a capture key counts as read-only. See
[features/33](../features/33-connect-ai.md). Disabled users
401 on both token kinds. Resetting a password, disabling a user, or an admin
overriding a password all **revoke sessions**.

Reset, invite and verify links are **mailed** by the worker
([features/41](../features/41-mail.md)); under the default `MAIL_TRANSPORT=log`
the whole message lands in the worker log instead. Reset and verify tokens are
also echoed as `debugToken` outside production. Signup auto-joins
`AUTH_DEFAULT_WORKSPACE_ID` as `AUTH_DEFAULT_ROLE` and mails a confirmation
link; any followed link sets `users.email_verified_at`. With
`AUTH_REQUIRE_VERIFIED_EMAIL=true`, an unverified **session** reaches only the
`@UnverifiedOk` routes (403 `emailUnverified` elsewhere, WS close 4403).

## The trusted-operator escape hatch

`POST /v1/graph/query` (and MCP `knowledge_query_graph`) is the one way to ask
the graph an arbitrary question. It is fenced on five sides:

1. **Single `SELECT` only**, enforced by a keyword blocklist.
2. **Row-capped** by `GRAPH_QUERY_MAX_ROWS`.
3. Wrapped in an **outer `SELECT` carrying the mandatory workspace predicate**.
4. **Rows without a `workspaceId` are dropped** — deny by default, so a query
   that projects away the tenant column returns nothing rather than everything.
5. **Audited** into `audit_logs`, readable at `GET /v1/audit-logs` (admin).
   The row carries `aclBypass: true`: the query reads the stores past every page
   restriction, as only an admin operator may.

## WebSockets are a separate door

`APP_GUARD`s do not run on a WebSocket upgrade. `TokenAuthService` — extracted
from `AuthGuard` and exported by the global `AuthModule` — resolves the principal
for the gateway, and every `subscribe` runs `AccessService.requireRole('viewer')`
in PostgreSQL **before the subscription exists**. See
[08 — Events & live updates](08-events-live.md).

Background work authenticates the same way: an agent run rehydrates a real
principal from `users` and calls the same `AccessService.requireRole` an HTTP
request would, which is what `AuthCoreModule` (AccessService without the guards)
exists to make possible in the worker.

### The audience clamp

A run whose output is read by more people than the person it acts for reads
that person's pages **clamped to its audience** (#76):
`PermissionService.audienceScope(scope, audience)` keeps a page D only when
`D.restricted_by ⊆ P.restricted_by`, where P is the destination page, or `{}`
for a workspace-wide audience. Everyone who can read P then passes every
restricted node on D's chain. The rule is expressed as extra `denied` nodes
(`clampToAudience` in `access-scope.ts`), so `canSee`, `visibilityWhere`,
`visibilitySql` and `documentFilterFor` apply it unchanged. A clamped scope
never bypasses: an admin's run is read by people who are not admins.

| Run | Acts for | Audience |
| --- | --- | --- |
| Assistant turn in the pane | the asker | none: the asker's own pages |
| Chat bot answer in a DM | the linked person | none |
| Chat bot answer in a group | the linked person | workspace |
| Chat subscription digest | nobody | workspace (`OPEN_TO_WORKSPACE`) |
| Agent run (every kind) | the run's owner | workspace: findings are listed to every member, and the sentinel's verdict reaches a pull request |
| Workflow `search` step | the run's owner | the run's source page |

The assistant's read tools take the audience from `AssistantToolContext.audience`
and ask `scopeFor` (then `audienceScope`) **on every tool call**, so a grant
revoked mid-turn holds from the next call. A page outside the scope is "not
found" to the model. The write tools check the page level (`edit`), and
creating a page needs edit on its parent, or on the project for a root page
(`requireCreateUnder`, the same check REST and MCP make). A sentinel asked to
judge a report on a page the clamp hides fails the run with
`agent.report.restricted`, which sends the report back to `open` for a person.

## Modules

`AuthModule` is `@Global()` and registers both guards. `AuthCoreModule` carries
`AccessService` and `AuditService` for worker-side use, and
`PermissionsCoreModule` carries `GroupsService`, `PermissionService` and
`ResourceAccessService` for every process; `AuthModule` imports it because
`AclGuard` asks it about the page behind a `:id`.
`UsersModule`, `WorkspacesModule` and `PermissionsModule` are **API-only**, for the same reason as `GraphQueryModule`: they carry
controllers, and controllers must not load in the worker
([01](01-entrypoints-modules.md)).

## Routes

```
POST /v1/auth/signup | login | forgot-password | reset-password   @Public()
POST /v1/auth/verify-email                                        @Public()
POST /v1/auth/logout | resend-verification                        authenticated, @UnverifiedOk()
POST /v1/auth/change-password                                     authenticated
GET  /v1/me   PATCH /v1/me                                        self
GET/POST/PATCH /v1/users                                          @PlatformAdmin()
GET/POST /v1/workspaces                                           creator → admin+operator
*    /v1/workspaces/:id/members                                   @Access(viewer|admin, 'workspace')
GET  /v1/groups?workspaceId=   POST /v1/groups                    @Access(viewer, 'query') | (admin, 'body')
PATCH|DELETE /v1/groups/:id   PUT /v1/groups/:id/members          @Access(admin, 'group')
GET  /v1/groups/:id/members                                       @Access(viewer, 'group')
GET|PUT /v1/documents/:id/access   GET …/access/effective         @Access(viewer, 'document') + manage for PUT/effective
GET|PUT /v1/projects/:id/access    GET …/access/effective         @Access(viewer, 'project') + manage for PUT/effective
POST /v1/access-requests   GET /v1/access-requests?workspaceId=   @Access(viewer, 'body'|'query', { guests: true })
POST /v1/access-requests/:id/approve | deny                     @Access(viewer, 'access-request') + manage on every grant target
POST /v1/access-requests/:id/cancel                             @Access(viewer, 'access-request', { guests: true }), requester only
POST /v1/graph/query                                              trusted_operator
GET  /v1/audit-logs                                               admin
```

## The public surface

`/v1/public/*` (docs/features/43, 44) is the one place an anonymous request
reads content. Its controllers are `@Public()`, so both guards step aside, and
authorisation is the service's job, re-done on every request with nothing
cached: `PublicSharesService` resolves the `kp_` token and confines every read
to the scope the link names; `PublicSitesService` resolves a live site (status,
workspace switch, env ceiling) and reads only its version's snapshot
(`site_version_pages`), never a branch head. Both answer 404 for anything
outside. A site's files (`sitemap.xml`, `robots.txt`, `llms*.txt`, a page's
`.md`) go through the same `PublicSitesService.find` and read the same
snapshot rows. `GET /v1/public/domains/allow` is Caddy's on-demand TLS check:
200 only for a hostname the platform routes to a site (an existing site's
`<slug>.PUBLISH_BASE_DOMAIN`, or a custom domain proven by its TXT record),
so certificates are never requested for names nobody claimed.
`PublicRateLimitGuard` caps them per IP, counting `X-Forwarded-For` only when
the peer is internal (Caddy, the web SSR). The `share-link`, `site`,
`site-version` and `site-domain` sources resolve their ids to a workspace for
the authenticated management routes, like every other source.

A site may keep pages from the public (issue #77 phase 3, feature 44
"Audiences"). That makes the public surface aware of a reader, but never of
the app's session: a site sign-in is its own httpOnly `kn_site_<siteId>`
cookie on the site's origin, mapped in Redis to a member (re-checked against
`workspace_members` and `users.disabled_at` on every request) or a visitor
(the claims of a customer-signed HS256 JWT, bound to the site's current
secret). A member gets there through one authenticated route,
`POST /v1/sites/:id/sign-in` (`viewer` on `site`), which mints a one-time code
only for a return address that is one of the site's own; the public
`…/session` route spends it. Every failure reads as anonymous, and a hidden
page is a 404, never a 403.

A site may also answer questions ([feature 44](../features/44-docs-portal.md#ask-phase-3)
"Ask"): `POST /v1/public/sites/:siteId/ask` is the one public route that
spends money, so it is the one whose limits **fail closed**. Reads fail open
when Redis is down; Ask's per-address rate (`PUBLIC_ASK_RATE_PER_MIN`) and
the site's daily budget (`askDailyBudget`, never above
`PUBLIC_ASK_DAILY_BUDGET`) refuse instead. It retrieves only from the rows
the reader may see (the same `visibleRows` and site cookie as a page read),
runs with no principal and no tools, and is billed as `public_ask` with
`userId` = the site's id, under the workspace's own AI budget. Embedding the
widget elsewhere is not an API decision at all: the `/_widget` frame is a
page of the site, same-origin with its API (no CORS), and its
`frame-ancestors` header, built from the site's `embed_origins`, is the whole
embed check.

Exports ([feature 45](../features/45-export.md)) are member-only. Asking for
one is `viewer` on the page or project it covers, so the guard resolves the
workspace from that id. The `export` source covers the job itself, and the
service narrows it further to the requester or an admin, since the row says who
exported what. The web's `POST /_internal/export/render` is not an API route
at all: the web server answers it only for an internal peer with no
`X-Forwarded-*` header, which no request through Caddy can be.

## Limits

- Page restrictions cover the REST routes, MCP (per-page guard, tree, graph,
  project and search tools; guests may use the search, tree and project
  tools), search (all three legs and graph expansion), every assistant tool,
  agent and workflow runs and chat bots (through the audience clamp above),
  notifications, the activity feed and live events, and connectors with
  mirroring on carry a source's restrictions onto the pages they write
  ([19](../features/19-connectors.md#access-mirroring-76-phase-6)). With
  mirroring off, the default, imported pages are open to the whole workspace
  unless restricted by hand. The product view is
  [48 — Page permissions](../features/48-page-permissions.md), and
  `test/page-permissions.e2e-spec.ts` exercises it as real users.
- A live connection may receive frames for up to `ACL_CACHE_TTL_MS` after a
  restriction tightens if it misses `acl.changed` (e.g. a Redis blip). Every
  request still reads PG, so this costs at most a few frames of titles, never
  content.
- The audience clamp is conservative: two pages restricted to the same people
  through different nodes still exclude each other. In a workspace whose pages
  are mostly restricted, agent runs and group chat answers see little.
- A `@reviewer` mention reply reads only the page and thread it was asked on,
  so it needs no clamp; it would need one the moment it gains retrieval tools.
- The clamp vouches for the members who can read the destination, not for a
  guest granted only that page: a guest reading a thread could be shown a
  page that is open to every member but not granted to them.
- Existing assistant threads, agent findings and chat messages that quoted a
  page before it was restricted are not redacted.
- Members who cannot open a page get a 403 that confirms it exists (the
  Confluence trade-off, so they can ask for access). There is no "hidden" flag
  that would make it a 404 for them.
- Mail is outbound only: no bounce handling, so a dead address stays unverified
  rather than being flagged.
- The trusted-operator query is read-only by construction but still trusts the
  blocklist; it is an escape hatch, not a query API.
