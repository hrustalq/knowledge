---
title: Authentication and access
section: Administration
summary: Two auth modes, two token kinds, and where each of the four permission checks happens.
---

# Authentication and access

## Two modes

`AUTH_MODE` decides whether authorization is real:

- **`none`** (default) — every request passes as a synthetic dev principal with full
  access. Demos and local development work with no login UI at all.
- **`api-key`** — real identities, real ACLs.

**Test permissions with a bootstrapped key, never in dev mode.** In `none` everything
passes, including the routes you forgot to guard.

## Two token kinds

| Prefix | Is | Minted by |
| --- | --- | --- |
| `ks_` | a session, TTL `AUTH_SESSION_TTL_HOURS` | login |
| `kn_` | an API key, long-lived | `make auth-bootstrap email=…`, printed once |

Both are stored as SHA-256 hashes and never in plaintext. Passwords use scrypt from
`node:crypto` — no dependency. Password reset tokens (`kr_`) are single-use with a short
TTL; reset links are logged rather than mailed, and echoed in the response outside
production.

Disabling a user, resetting their password or overriding it **revokes their sessions**.

## Where the checks happen

Four layers, in order:

1. **AuthGuard** resolves the principal from the bearer token — or from `?token=`, because
   `EventSource` cannot set headers. Failure is **401**.
2. **AclGuard** reads the route's `@Access(role, source)` and resolves the target workspace
   *in Postgres, before the handler runs* — so no graph query ever executes for a request
   that was going to be refused. Failure is **403**.
3. **Service invariants** handle what ACLs cannot express: the last admin cannot be
   removed, the last project cannot be deleted, a non-empty project cannot be deleted.
4. **Re-authorization** inside AI tool loops: every tool call an agent or the assistant
   makes is checked against the caller's session again.

A route with no `@Access` is authenticated-only with **no workspace check** — which is
fine for `/v1/me` and wrong for anything scoped. The
[API reference](/settings/docs/api-reference) marks those explicitly so the list can be
audited rather than assumed.

## Roles

`viewer` < `editor` < `admin`, per workspace. Plus:

- **`trusted_operator`** — may run raw graph queries: a single `SELECT`, keyword
  blocklisted, row-capped by `GRAPH_QUERY_MAX_ROWS`, wrapped in an outer select that
  applies the workspace predicate and **drops any row that cannot prove its workspace**,
  and written to the audit log.
- **`is_admin`** on the user — platform admin. Bypasses workspace ACLs and gates account
  management. Self-disable and self-de-admin are blocked, so the last one cannot lock
  everyone out.

## Signup

`AUTH_SIGNUP_ENABLED` controls whether `/signup` works. New accounts auto-join
`AUTH_DEFAULT_WORKSPACE_ID` with `AUTH_DEFAULT_ROLE`, which is what makes the demo
workspace usable immediately.

## In the browser

The token lives in `localStorage` plus `kn_token` / `kn_ws` cookies. The cookies exist so
the **server-rendered pass** is authenticated — read per request through async-local
storage, so concurrent renders can never see each other's tokens. That is why an
authenticated page arrives rendered rather than as a spinner.
