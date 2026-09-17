# 06 — Auth & ACLs

Two guards, resolved in PostgreSQL before a handler runs. Authentication says who
you are; authorization says which workspace you may touch, and it is answered
_before_ any graph or storage query is issued.

## What this is

`AUTH_MODE` switches the whole posture:

| Mode                | Behaviour                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `none` _(default)_  | Every request is a synthetic **dev principal** with full access             |
| `api-key`           | `Authorization: Bearer` resolved against sessions or API keys               |

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
   (signup, login, forgot/reset password). It also accepts `?token=`, because
   `EventSource` cannot set headers.
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

`viewer < editor < admin`, held in `workspace_members`, plus a separate
**`trusted_operator`** flag that is not a role — it gates the raw graph query and
nothing else.

`users.is_admin` is a **platform** admin: it bypasses workspace ACLs entirely and
gates `@PlatformAdmin()` routes (`GET/POST/PATCH /v1/users`). **Self-disable and
self-de-admin are blocked** — the one thing a platform admin may not do is remove
the last way back in. `make auth-bootstrap` marks its user platform admin by
default.

`WorkspacesService` holds the matching invariant for workspaces: **the last admin
cannot be demoted or removed.**

## Credentials

Everything is hashed; nothing reversible is stored.

| Secret          | Prefix | Storage                                       |
| --------------- | ------ | --------------------------------------------- |
| Password        | —      | **scrypt** via `node:crypto`, no dependencies |
| Session token   | `ks_`  | SHA-256 in `sessions`                          |
| API key         | `kn_`  | SHA-256 in `users.api_key_hash`                |
| Reset token     | `kr_`  | SHA-256, single-use, TTL `AUTH_RESET_TTL_MIN`  |

API keys are **printed once** at bootstrap and never retrievable. Disabled users
401 on both token kinds. Resetting a password, disabling a user, or an admin
overriding a password all **revoke sessions**.

There is no mailer: **reset links are logged**, and echoed as `debugToken`
outside production. Signup auto-joins `AUTH_DEFAULT_WORKSPACE_ID` as
`AUTH_DEFAULT_ROLE`.

## The trusted-operator escape hatch

`POST /v1/graph/query` (and MCP `knowledge_query_graph`) is the one way to ask
the graph an arbitrary question. It is fenced on five sides:

1. **Single `SELECT` only**, enforced by a keyword blocklist.
2. **Row-capped** by `GRAPH_QUERY_MAX_ROWS`.
3. Wrapped in an **outer `SELECT` carrying the mandatory workspace predicate**.
4. **Rows without a `workspaceId` are dropped** — deny by default, so a query
   that projects away the tenant column returns nothing rather than everything.
5. **Audited** into `audit_logs`, readable at `GET /v1/audit-logs` (admin).

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

## Modules

`AuthModule` is `@Global()` and registers both guards. `AuthCoreModule` carries
`AccessService` alone for worker-side use. `UsersModule` and `WorkspacesModule`
are **API-only**, for the same reason as `GraphQueryModule`: they carry
controllers, and controllers must not load in the worker
([01](01-entrypoints-modules.md)).

## Routes

```
POST /v1/auth/signup | login | forgot-password | reset-password   @Public()
POST /v1/auth/logout | change-password                            authenticated
GET  /v1/me   PATCH /v1/me                                        self
GET/POST/PATCH /v1/users                                          @PlatformAdmin()
GET/POST /v1/workspaces                                           creator → admin+operator
*    /v1/workspaces/:id/members                                   @Access(viewer|admin, 'workspace')
POST /v1/graph/query                                              trusted_operator
GET  /v1/audit-logs                                               admin
```

## Limits

- ACLs stop at the workspace. There are no project-level roles; projects are
  organizational only ([feature 11](../features/11-projects.md)). The `'project'`
  guard source is the hook if that ever changes.
- No mailer, so password reset is operationally manual outside development.
- The trusted-operator query is read-only by construction but still trusts the
  blocklist; it is an escape hatch, not a query API.
