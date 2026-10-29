---
title: Authentication and access
section: Administration
summary: Two auth modes, the token kinds, single sign-on, and where each of the four permission checks happens.
---

# Authentication and access

## Two modes

`AUTH_MODE` decides whether authorization is real:

- **`none`** (default) — every request passes as a synthetic dev principal with full
  access. Demos and local development work with no login UI at all.
- **`api-key`** — real identities, real ACLs.

**Test permissions with a bootstrapped key, never in dev mode.** In `none` everything
passes, including the routes you forgot to guard.

## Token kinds

| Prefix   | Is                                       | Minted by                                                               |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `ks_`    | a session, TTL `AUTH_SESSION_TTL_HOURS`  | password login, or single sign-on                                       |
| `kn_`    | an API key — named, many per person      | **Settings → Connect AI**, or `make auth-bootstrap email=…`; shown once |
| `kscim_` | a SCIM provisioning token, one workspace | **Settings → Security → Provisioning**; shown once                      |

All are stored as SHA-256 hashes and never in plaintext. A `kscim_` token is not a
person: it opens the SCIM endpoints of its own workspace and nothing else. Passwords use scrypt from
`node:crypto` — no dependency. Password reset tokens (`kr_`) are single-use with a short
TTL; reset links are logged rather than mailed, and echoed in the response outside
production.

Disabling a user, resetting their password or overriding it **revokes their sessions**.
Each session records how it was opened (`password`, `oidc`, `saml` or `ldap`), its IP,
browser and last use. **Settings → Profile** lists yours and signs any of them out.

An API key can be **read-only**, **pinned to one workspace** or **expiring**, and each is
revoked on its own. The narrowing only ever takes rights away: a read-only key held by a
platform admin still cannot write. Keys are created and revoked from a signed-in
session — never with another key, so a leaked key cannot mint its own replacement.

## Where the checks happen

Four layers, in order:

1. **AuthGuard** resolves the principal from the bearer token. Two kinds of route
   cannot get a header and have a narrow fallback: the SSE stream reads `?token=`,
   which must be a single-use `kt_` ticket (`POST /v1/auth/url-ticket`), and the
   `<img>` redirects (attachments, import images, avatars) read the web's session
   cookie. Everywhere else both are ignored. Failure is **401**.
2. **AclGuard** reads the route's `@Access(role, source)` and resolves the target workspace
   _in Postgres, before the handler runs_ — so no graph query ever executes for a request
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

## Single sign-on

With `AUTH_SSO_ENABLED`, a workspace signs people in through its own identity provider:
OpenID Connect (Keycloak, Entra ID, Google, Yandex ID, or any other), SAML 2.0, or an LDAP /
Active Directory bind. Roles can come from the provider's groups, a SCIM client can create
and remove people, and a workspace can **require** SSO: every session reaching it must then
come from one of its providers, checked inside the same `requireRole` as every other
permission. Setup is in [Single sign-on & SCIM](/settings/docs/sso-scim).

## Signup

`AUTH_SIGNUP_ENABLED` controls whether `/signup` works. New accounts auto-join
`AUTH_DEFAULT_WORKSPACE_ID` with `AUTH_DEFAULT_ROLE`, which is what makes the demo
workspace usable immediately.

## In the browser

The token lives in `localStorage` plus `kn_token` / `kn_ws` cookies. The cookies exist so
the **server-rendered pass** is authenticated — read per request through async-local
storage, so concurrent renders can never see each other's tokens. That is why an
authenticated page arrives rendered rather than as a spinner.
