# 54 — Enterprise auth: single sign-on, SCIM and enforced SSO

Issue [#75](https://github.com/hrustalq/knowledge/issues/75), shipped as eight
PRs (#275, #276, #281–#283, #286, #287 and the one carrying this document).
Before it, the only way in was an email and a password. Nobody could sign in
through the company's identity provider. Nobody could create, demote or remove
people from the company's directory, and a workspace could not require either.
Every member of a regulated team was an account that HR's offboarding never
reached.

Now a workspace signs people in through its own identity provider (OpenID
Connect, SAML 2.0, or an LDAP / Active Directory bind). It derives their roles
from the provider's groups, lets the directory provision and deprovision them
over SCIM 2.0, and can refuse every session its provider did not open.

This document is the product layer. The mechanics live in
[06 — Auth & ACLs](../architecture/06-auth-acl.md#single-sign-on-75), and the
operator's setup recipes in the in-app manual (**Settings → Docs → Single
sign-on & SCIM**, `apps/web/src/pages/docs/content/46-sso-scim.md`).

## What

- **Identity providers**, owned by a workspace, under **Settings → Security →
  Providers**. Kinds are `oidc` (presets Keycloak, Microsoft Entra ID, Google
  Workspace, Yandex ID, generic), `saml` and `ldap`. A platform admin may mark a
  provider **platform-wide**, so a single-tenant install offers it on every
  login page.
- **An email-first login page.** The address decides the next step: a password,
  a redirect to the domain's provider, or an LDAP username and password form.
  Providers with `showOnLogin` also appear as **Continue with …** buttons.
- **JIT accounts.** A provider may create the account on first sign-in, with a
  default role in its workspace.
- **Group → role mapping**, under **Settings → Security → Group mapping**. A
  group from a provider's groups claim, or a SCIM group, maps to a workspace
  role and optionally to trusted operator.
- **Enforced SSO**, under **Settings → Security → Policy** and **Domains**. A
  workspace can require that every session reaching it was opened by one of its
  providers, block `kn_` keys while it does, and cap session age. A verified
  email domain can refuse password sign-in, signup and reset outright.
- **SCIM 2.0** at `<API_PUBLIC_URL>/v1/scim/v2`, with a per-workspace `kscim_`
  bearer token minted under **Settings → Security → Provisioning**.
- **Sessions you can see.** **Settings → Profile** lists every live session with
  how it was opened, its IP, browser and last use, and signs any of them out. A
  platform admin can do the same for anyone, over the API.
- **A workspace audit log** under **Settings → Security → Audit**, and the
  platform's own at `GET /v1/admin/audit-logs`.

Everything is off by default. With `AUTH_SSO_ENABLED`, `AUTH_SCIM_ENABLED` and
`AUTH_LDAP_ENABLED` at their defaults (`false`), the SSO and SCIM routes and
settings answer 404, the login page is the password form it was, and every
existing session reads as `authMethod: 'password'` and every membership as
`source: 'manual'`. `AUTH_MODE=none` keeps the dev principal and never offers
any of it.

## The rules

**A provider may assert only the domains it is given.** `allowedDomains` is the
guard for every kind. A sign-in links to an existing account, or creates one,
only when the address is verified by the provider and on one of those domains.
An empty list means the provider can sign in people it has already linked, and
nobody else. "Verified" means:

| Kind / preset                    | Verified when                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC (Keycloak, Google, generic) | `email_verified` is true                                                                                                                                                                                   |
| OIDC, Entra ID                   | `email_verified`, or the optional `xms_edov` claim. The tenant is pinned: a token whose `tid` is not the issuer's tenant is refused                                                                        |
| OIDC, Yandex ID                  | `default_email` is present (Yandex only makes a confirmed address the default). Yandex is OAuth 2 + userinfo: there is no discovery document and no id_token, so no nonce. State and PKCE protect the code |
| SAML                             | the email comes from a signed assertion                                                                                                                                                                    |
| LDAP                             | the email comes from the directory entry the password just bound as                                                                                                                                        |

An unverified address, or one on a foreign domain, never takes over an
existing account. The sign-in fails with `email-not-verified` or
`domain-not-allowed`.

**The session token never appears in a URL.** OIDC and SAML end on our callback,
which redirects the browser to `/sso/complete` with a 60-second single-use code
in the URL fragment. The browser trades it for the `ks_` session at
`POST /v1/auth/sso/exchange`. A fragment reaches no server log and no `Referer`.

**Every login transaction is single-use.** The `state` (OIDC), the RelayState
and `InResponseTo` (SAML), each SAML assertion ID, each back-channel `jti` and
each exchange code is spent exactly once, as a consumed row in
`sso_auth_requests` whose unique hash turns a replay into a constraint error. A
forged, replayed or expired attempt sends the browser to `/login?error=<code>`
(`SSO_LOGIN_ERRORS` in contracts) and writes `auth.login_failed` with the
reason.

**Roles from groups.** On each SSO sign-in, the person's groups are matched
against the mappings of the provider they used. The highest mapped role wins,
and any matching mapping with `trustedOperator` grants it. With no match, the
provider's `defaultRole` applies in its own workspace. Each provider has a
`groupSyncMode`:

- **`additive`** — a sign-in only raises a role.
- **`authoritative`** — each sign-in sets the role from the groups, and removes
  the membership when no group maps.

A SCIM group's mapping (no provider) applies the moment provisioning changes
the group. `RoleSyncService` is the one writer of these, and three rules hold
whatever the mode:

- A membership someone set by hand (`source = 'manual'`) is never changed.
  Editing a synced member's role answers 409 `managedByIdp` until an admin
  chooses **Manage manually**, which converts it.
- A change that would demote or remove a workspace's last admin is skipped and
  audited as `role_sync.blocked_last_admin`.
- An Entra ID token with more than 200 groups carries an overage reference
  instead of a list. It reads as "no groups known", so sign-in takes nothing
  away.

**Enforcement is one check on every request.** `AccessService.requireRole`
calls `AuthPolicyService` after a key's narrowing. The web app, REST, MCP tool
calls and WebSocket subscriptions therefore all meet the same rule. A session
satisfies an enforcing workspace only if one of its providers, or a
platform-wide one, opened it. The refusal is 403 with `details.reason`. A
refused MCP tool call returns the message and then a second text block,
`{ statusCode, message, details }`, with the same `details`:

| `reason`         | When                                                                            | The web app                                                        |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ssoRequired`    | a password session, or a session from a provider this workspace does not accept | sends the person to `/login` with the providers to sign in through |
| `apiKeysBlocked` | a `kn_` key, under enforced SSO with `allowApiKeys` off                         | —                                                                  |
| `reauthRequired` | a session older than `sessionMaxAgeHours`, with or without enforced SSO         | asks the person to sign in again                                   |

Platform admins pass as break-glass, and each crossing writes
`auth.sso_bypassed` (once an hour per credential and workspace). Unattended work
(an agent run, a workflow node, a chat turn executing as its owner) carries no
session or key and is not judged: whoever started it already passed. The policy
is cached in-process for 30 seconds, so a second API instance or the worker may
lag a change by that much. Saving a policy that would lock out the admin saving
it answers 409 `policyLocksYouOut`. Saving enforced SSO with no live provider
answers 400.

**Domains.** A workspace claims an email domain and proves it with a DNS TXT
record at `_knowledge-challenge.<domain>`. The record is checked on demand and
every 15 minutes for a week, and a platform admin may mark a domain verified by
hand. Only a verified domain can be enforced. Once it is, password `login`,
`signup` and `forgot-password` refuse its addresses with 403
`ssoRequiredForDomain`. `forgot-password` still answers `{ ok: true }` and mints
nothing, so it reveals nothing. Addresses in `AUTH_BREAK_GLASS_EMAILS` still get
in with a password, and so do platform admins where the workspace sets
`allowPasswordForAdmins`. A domain belongs to one workspace, and a pending claim
stops holding it after a week.

**SCIM changes only what the workspace owns.** A SCIM token provisions its own
workspace and opens no other route. It is a credential for provisioning, never a
principal. Deactivating or deleting a user removes the membership provisioning
manages, along with the JIT and group memberships SCIM takes over, and revokes
the person's sessions everywhere. Provisioning disables the global account
(`users.disabled_at`) and rewrites its name and email only when the address's
domain is one this workspace has verified. Otherwise one workspace's directory
could lock someone out of another.

**Deleting a provider signs out the sessions it opened.** So does an OIDC
back-channel logout: a `logout_token` with a `sid` ends the sessions that IdP
session opened, and one with only a `sub` ends every session that person opened
through that provider.

## Where people meet it

- **`/login`** (`LoginPage.vue`): email first, then the password field, an LDAP
  form, or a redirect. Callback errors arrive as `?error=` and are shown in the
  reader's language. A `?reauth=sso|session` query keeps a signed-in person on
  the page to sign in again.
- **`/sso/complete`** (`SsoCompletePage.vue`): reads the code from the fragment,
  exchanges it, and lands on `returnTo` (only a path on this app).
- **Settings → Security** (workspace admins), one tab each: **Providers**
  (protocol, preset, the redirect, ACS, metadata and back-channel URLs to copy,
  **Test**), **Group mapping**, **Policy** (what was asked beside what applies,
  so a clamp by `AUTH_SSO_ENABLED` is visible), **Domains**, **Provisioning**
  (the SCIM base URL, tokens shown once, the default role, counts) and
  **Audit**.
- **Access → Members** shows where a synced member's role comes from, with
  **Manage manually**.
- **Settings → Profile → Sessions** for one's own sessions. A platform admin
  reaches anyone's over the API only; there is no admin screen for it yet.

## API

| Route                                                                                                           | Who                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /v1/auth/sso/providers` · `POST /v1/auth/sso/discover` `{ email }`                                         | public; `discover` is rate limited and fails open       |
| `GET /v1/auth/oidc/:providerId/start` · `GET …/callback`                                                        | public, browser redirects                               |
| `GET /v1/auth/saml/:providerId/start` · `POST …/acs` (303) · `GET …/metadata`                                   | public; metadata is served for a disabled provider too  |
| `POST /v1/auth/ldap/:providerId/login` `{ username, password }`                                                 | public, rate limited per IP and per username            |
| `POST /v1/auth/sso/exchange` `{ code }`                                                                         | public, rate limited, fails closed                      |
| `POST /v1/auth/oidc/:providerId/backchannel-logout`                                                             | public; the signed `logout_token` is the credential     |
| `GET`/`POST /v1/workspaces/:id/identity-providers` · `PATCH`/`DELETE …/:providerId` · `POST …/:providerId/test` | workspace admin; `platformWide` needs a platform admin  |
| `GET`/`POST /v1/workspaces/:id/group-mappings` · `DELETE …/:mappingId`                                          | workspace admin                                         |
| `GET`/`PUT /v1/workspaces/:id/auth-policy`                                                                      | workspace admin                                         |
| `GET`/`POST /v1/workspaces/:id/sso-domains` · `POST …/:domain/verify` · `PATCH`/`DELETE …/:domain`              | workspace admin; a manual verify needs a platform admin |
| `GET`/`PUT /v1/workspaces/:id/scim` · `POST /v1/workspaces/:id/scim-tokens` · `DELETE …/:tokenId`               | workspace admin                                         |
| `/v1/scim/v2/ServiceProviderConfig`, `ResourceTypes`, `Schemas`, `Users`, `Groups`                              | a `kscim_` token for that workspace                     |
| `GET /v1/me/sessions` · `DELETE /v1/me/sessions/:sessionId`                                                     | self                                                    |
| `GET /v1/users/:id/sessions` · `POST /v1/users/:id/revoke-sessions`                                             | platform admin                                          |
| `GET /v1/audit-logs?workspaceId=&action=&cursor=`                                                               | workspace admin                                         |
| `GET /v1/admin/audit-logs`                                                                                      | platform admin; null-workspace (platform) events        |

`PATCH /v1/workspaces/:id/members/:userId` accepts `convertToManual: true`.
`GET /v1/me` reports `authMethod`, and each membership its `source`
(`manual | jit | group | scim`).

SCIM supports create, read, `PUT`, `PATCH` and delete for Users and Groups.
Filters are `userName`, `externalId` and work-email `eq` for users, and
`displayName` and `externalId` for groups, with paging up to
`AUTH_SCIM_MAX_PAGE`. Entra's `"False"` strings and capitalised ops are
accepted, as is Okta's member removal by filter. Errors are
`application/scim+json` in the RFC 7644 shape.

## Audit

Every value of `AUDIT_ACTIONS` is written by at least one code path, and
`audit.service.spec.ts` fails if one stops being. A filter never offers an
action nothing records. This milestone added:

- **sign-in:** `auth.login`, `auth.login_failed`, `auth.logout`,
  `auth.session_revoked`, `auth.sso_bypassed`;
- **providers and accounts:** `sso.provider_created` / `_updated` / `_deleted`,
  `sso.jit_user_created`, `sso.identity_linked`;
- **group mapping:** `sso.group_mapping_created` / `_deleted`,
  `role_sync.applied`, `role_sync.blocked_last_admin`;
- **domains and policy:** `sso.domain_claimed` / `_verified` / `_enforced` /
  `_updated` / `_removed`, `sso.policy_updated`;
- **provisioning:** `scim.user_created` / `_updated` / `_deactivated` /
  `_deleted`, `scim.group_created` / `_updated` / `_deleted`,
  `scim.token_created` / `_revoked`, `scim.settings_updated`.

Each row carries the client `ip` and a `target`. Sign-ins before a workspace is
known belong to no workspace (`workspace_id` null): a platform admin reads those
at `GET /v1/admin/audit-logs`, or by switching the Audit tab to the whole
platform.

## Data

All from `20261109100000_enterprise_auth`, plus two small follow-ups. No FK on
`workspace_id` or user columns (house policy).

- `identity_providers`: kind, preset, the protocol config, `secret_cipher`
  (client secret, SAML SP private key or LDAP bind password, AES-256-GCM under
  `SETTINGS_ENCRYPTION_KEY`, write-only over the API), `platform_wide`, JIT,
  `allowed_domains`, groups claim and sync mode, and session TTL.
- `user_identities`: (provider, subject) → user. The subject is the OIDC `sub`,
  the SAML NameID, or LDAP `entryUUID` / `objectGUID`, never a DN, so a rename or
  a move keeps the account. One person in two workspaces with two providers has
  two identities on one `users` row.
- `sso_auth_requests`: login transactions, and the consumed markers for replay.
  `idp_session_id` (`20261110100000_sso_request_idp_session`).
- `sso_domains`, `idp_group_mappings`, `scim_tokens`, `scim_users` (with
  `user_name`, `20261111100000_scim_provisioning`), `scim_groups`,
  `scim_group_members`.
- On `sessions`: `auth_method` (default `'password'`), `provider_id`,
  `idp_session_id`, `ip`, `user_agent`, `last_seen_at` (touched at most once a
  minute). On `workspace_members`: `source` (default `'manual'`). On
  `audit_logs`: `ip`, `target`, nullable `workspace_id`. On
  `workspace_settings`: `sso_enforced`, `allow_api_keys`,
  `allow_password_for_admins`, `session_max_age_hours`, `scim_default_role`.

Every migration is additive and needs no backfill, so rolling back to the
previous image is safe.

## Configuration

All have defaults, and with the defaults nothing changes.

| Var                           | Default | Meaning                                                                                                                                  |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SSO_ENABLED`            | `false` | OIDC and SAML providers, discovery, enforced SSO and domains. Needs `AUTH_MODE=api-key`                                                  |
| `AUTH_SSO_ALLOW_PRIVATE_URLS` | `false` | Lets an issuer, SSO URL or directory sit on a private address (an on-prem Keycloak or AD)                                                |
| `AUTH_SSO_STATE_TTL_SEC`      | `600`   | Lifetime of a login transaction, and the oldest SAML response accepted                                                                   |
| `AUTH_PASSWORD_LOGIN_ENABLED` | `true`  | `false` refuses password login, signup and reset for every address outside `AUTH_BREAK_GLASS_EMAILS`                                     |
| `AUTH_BREAK_GLASS_EMAILS`     | empty   | Comma-separated addresses that may always use a password                                                                                 |
| `AUTH_LDAP_ENABLED`           | `false` | The `ldap` provider kind. Rides on `AUTH_SSO_ENABLED`. Off again, LDAP providers stop signing in and stop satisfying enforcement at once |
| `AUTH_LDAP_ALLOW_INSECURE`    | `false` | Allows plain `ldap://` without StartTLS. Sends passwords in clear text: a lab setting                                                    |
| `AUTH_SCIM_ENABLED`           | `false` | `/v1/scim/v2` and the Provisioning tab. Needs `AUTH_MODE=api-key`, independent of SSO                                                    |
| `AUTH_SCIM_MAX_PAGE`          | `200`   | The largest SCIM list page a client may ask for                                                                                          |
| `SETTINGS_ENCRYPTION_KEY`     | —       | Needed to store a client secret, a SAML SP key or an LDAP bind password (400 `error.sso.secretKeyMissing` without it)                    |

Rate limits (per minute, Redis-backed): password login 30 per IP and 10 per
address, LDAP login 30 per IP and 10 per username, exchange 30 per IP. All three
fail closed when Redis is down. Discovery allows 60 per IP and fails open, since
it only picks a login button.

## Verification

- `make verify` with every new variable at its default, and the existing auth
  specs unchanged.
- API specs, in `apps/api/test/`:
  - `sso-oidc.spec.ts`: code + PKCE, state, nonce, expiry, exchange reuse, JIT,
    linking, presets and back-channel logout;
  - `sso-saml.spec.ts`: signed Response or Assertion accepted; unsigned, wrong
    key, audience, issuer, `InResponseTo`, replay and an XSW fixture refused;
    IdP-initiated sign-in;
  - `sso-ldap.spec.ts`: the uniform 401, filter escaping, TLS refusals and the
    ldapts implicit-TLS trap;
  - `enforced-sso.spec.ts`: the policy matrix on REST, MCP and WS, domains, and
    break-glass;
  - `role-sync.spec.ts`, `scim.spec.ts`, `sessions.service.spec.ts`,
    `audit.service.spec.ts`;
  - `scim-filter.spec.ts` in `src/scim/`.
- Web: `lib/sso.spec.ts` covers the fragment-only exchange code, the
  `?reauth=` redirect, `returnTo` confinement, and that every callback error has
  an en and ru message.
- Live, per phase: Keycloak 26 for OIDC, SAML and back-channel logout
  (`make infra-up-keycloak`), lldap for LDAP, and SCIM driven with curl. The
  phase handoffs on #75 record the recipes.

## Limits

- **No SAML single logout,** and no rotation route for the SP key pair. Rotating
  `SETTINGS_ENCRYPTION_KEY` leaves SAML providers unable to sign in until they
  are recreated, and **Test** says so.
- **No per-provider CA for LDAP.** The directory's certificate is checked
  against the system CAs plus `NODE_EXTRA_CA_CERTS`.
- **Entra group overage** is read as no groups. Use SCIM or app roles (the
  `roles` claim as the groups claim) for people in more than 200 groups. A
  Graph lookup is a follow-up.
- **Google and Yandex send no groups.** Map their people by hand or provision
  them over SCIM.
- **One session per browser.** Enforced SSO in workspace A refuses a session
  opened by workspace B's provider, and the person signs in again through A's.
  There is no multi-session switcher.
- **The policy cache** lets another process enforce a changed policy up to 30
  seconds late.
- **Login error toasts** follow the API's `Accept-Language` / `kn_lang`, which a
  cross-origin request from the login page does not always carry, so a Russian
  UI can show an English toast. Password login shares this.
- **Out of scope:** per-page or per-project SSO, a Graph lookup for Entra
  groups, SCIM `Bulk` and `/Me`, and an IdP-side app catalogue.
