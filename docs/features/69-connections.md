# 69 — Connections

Issue: [#564](https://github.com/hrustalq/knowledge/issues/564). PRs #565 (model), #567 (API), #568 (OAuth
per connection, landing page), #569 (Connections tab, connect flow), #570 (link screen). Per-user
credentials: [#857](https://github.com/hrustalq/knowledge/issues/857), PRs #858 (schema + backfill), #859
(API) and the web PR — see [Credentials](#credentials-857).

## What

A **connection** is one account's access to one upstream system, held by a workspace and shared by every
connector of a compatible kind. It has a `provider` and exactly one `method`:

| method  | holds                                                                                 | providers |
| ------- | ------------------------------------------------------------------------------------- | --------- |
| `token` | a person's credential holding a pasted secret (PAT, `email:api-token`, API key, service-account JSON) | all       |
| `app`   | a GitHub App installation id; syncs as the installation, browses as the person (doc 30) | GitHub    |
| `oauth` | a person's Figma sign-in credential; `external_ref` is the Figma user id (#557)          | Figma     |

Adding a connector is one flow: **service → sign in → resources → done**. Sign in reuses an account the
workspace already connected, pastes a token, or finishes the App / OAuth leg in another tab. Resources
lists what the connection reaches; each picked resource goes to one or more projects, and every
resource↔project pair becomes **its own connector**.

## Why

The credential lived on the connector. Two Confluence spaces under one account meant pasting the same
`email:api-token` twice; rotating it meant editing every connector holding a copy; nothing said which
accounts a workspace was connected through. Only GitHub had a repository picker, only behind the App, and
the App's presence decided — not the person — whether a PAT could be used at all. One wizard pass created
one connector for one project. And the OAuth callback landed on a list page that said nothing, while the
tab that started the flow updated only when it regained focus.

## Decisions

- **Provider is derived, never chosen.** `connectionProviderFor(kind, config)` (contracts) maps a kind —
  and the host, for git kinds — to `{ provider, site }`. Confluence Cloud and Jira on one site are one
  `atlassian` provider; `codebase` and `markdown-git` on github.com one `github`; a host calling itself
  GitLab is `gitlab` with its origin as `site`; anything else is `git`. Intercom's `site` is its region's
  API host, because a token belongs to one region. `repoHost` in `repo-archive.ts` reads the same host
  rule (`gitProviderOf`). `connectionKindsFor` is the inverse, for the connect flow.
- **The connection is the only source** — `ConnectorsService.credentialFor` dials through
  `connectors.connection_id` (token → its credential's secret, app → `GithubAppService.installationToken`,
  oauth → `FigmaOauthService.tokenFor` with renew) and refuses a connection from another workspace (403).
  A connector with no connection sends no credential (a public repository).
- **One writer of `connection_id` when no connection is chosen: `bindConnection`.** It points a connector
  at the connection its own settings imply — the installation or Figma sign-in in its config, else the
  token it was given — and reuses an equal connection before creating one, comparing **decrypted** secrets
  (two envelopes of one secret never match). It runs on create, on any update that touches the credential
  or config (an update that sends no token keeps the one its connection dials with, so a new repository
  host gets its own connection for the same secret; `null` unbinds), and on the Figma OAuth bind/unbind.
  A connector keeps no secret of its own: the pasted `credential` on `POST`/`PATCH /v1/connectors`
  becomes its creator's credential and a connection (#857).
- **Backfilled at boot, then removed.** #564's `ConnectionsBackfill` bound every connector and recorded
  installation at API boot, and #857's moved every sign-in into `credentials`; both were removed in #857
  phase 4, once production had run them. Recording an installation creates its `app` connection.
- **Saving a token identifies the account** through a cheap probe per provider
  (`adapters/connection-providers.ts`: `GET /user`, `/api/v4/user`, `/rest/api/3/myself`, `/users/me`,
  `viewer`, `/v1/me`, …; a service-account key names itself; plain `git` has no account API). A token
  upstream refuses is never stored. The same account again **rotates** that connection. `PATCH` refuses a token for another account (409): it would
  silently move every connector on it.
- **In use is not deletable.** `DELETE` answers 409 with `connectors: [names]`. Removing a pair is the
  connector's own delete; the link screen never deletes.
- **One connector per pair, duplicates refused.** `connectorResourceKey(kind, config)` folds the kind's
  `CONNECTOR_RESOURCE_KEYS` (repo URL + folder, space key + root page, database id, …; case, a trailing
  `/` and `.git` folded). `POST :id/links` reports a pair that already exists — or repeats within one
  request — with its connector instead of creating it.
- **Probes, listings and branches are per provider, not per adapter.** One GitHub connection backs two
  kinds; methods on eleven adapters would duplicate the probe. The module reuses each adapter's header
  helper, so a probe dials exactly as a sync does. GitHub App listings go through `GithubBrowseService`
  as the person (doc 30); a token lists `/user/repos`; GitLab `/projects?membership=true`; Confluence
  Cloud spaces; Jira projects; Notion databases. Everything else answers `listable: false` and the link
  screen shows that kind's typed fields.
- **No token once signed in through OAuth or the App.** `offeredMethods` offers a provider's methods
  this server can finish (`app` / `oauth` need their env keys) and drops the token as soon as an `app` /
  `oauth` connection exists for the provider, or — GitHub — the person's own GitHub sign-in is done. With
  every `GITHUB_APP_*` / `FIGMA_OAUTH_*` key empty, the flow is token only and complete.
- **One landing page for every callback.** GitHub (OAuth and install) and Figma redirect every outcome —
  a forged or expired `state` included — to `${WEB_BASE_URL}/oauth/:provider?outcome=&returnTo=`
  (`oauthLandingPath`, `OAUTH_OUTCOMES`). The page is public and reads only its query: success closes the
  script-opened tab after a beat, a failure stays and explains, and **Go back** follows `returnTo` only
  when it is a same-origin path.
- **Long poll, focus as fallback.** `GET /v1/connections/wait?workspaceId=&since=` answers when a
  fingerprint of the workspace's connections, its App installations and the caller's GitHub identity
  moves off `since`, or after ~25 s; ~1 s steps; stops when the client disconnects; `no-store`. The web
  `useConnectionsWait` loops on it, so the starting tab moves on whether or not it has focus.
- **The setup wizard edits; it no longer creates.** Its credential step is a picker of the connections
  whose provider and site match the connector (`UpdateConnectorDto.connectionId`), with "paste a token for
  this connector" kept as the escape.

## Credentials (#857)

A connection is the workspace's grant ("workspace W uses account X"); the secret is a **credential**: one
person's sign-in to one upstream account, in `credentials`, reused by every workspace that person binds it
into. `connections.credential_id` points at it (FK, `RESTRICT`); an `app` connection has none, because an
installation belongs to a GitHub account or org, not to a person.

- **Matching.** A pasted token is the same credential only when the same owner pastes the **same secret**
  for the same provider and host (`tokenCredential` in `connection-binding.ts`, compared decrypted) —
  never by account, because two fine-grained tokens for one account reach different repositories. A
  GitHub sign-in is one per person; a Figma sign-in is one per **Figma account across every owner**, since
  Figma keeps one token per app per Figma user: a second person signing in to an account someone else
  holds lands on `outcome=account-in-use`, and is never told whose.
- **Host.** `credentialSiteFor`: an Atlassian credential has no site (its token reaches every site the
  account can) and is probed on the site of the workspace it is bound into; GitLab, Confluence Server,
  Zendesk, Intercom, git and web credentials keep their host.
- **Only the owner binds.** `POST /v1/connections { credentialId }` and `PATCH … { credentialId }` take
  only the caller's own credential (`CredentialsService.requireOwn`, 403). A GitHub sign-in is not
  bindable (`credentialBindable`): it is who the person browses as.
- **Resolved live.** `connectionSecret` dials `connection → credential`, so the owner's rotation (Connections
  tab or Connected accounts) reaches every workspace at once. Anyone else's token on a connection moves
  that connection onto **their** credential and leaves the owner's alone.
- **Owner left** is derived on read (`ConnectionSummary.ownerLeft`): the owner is not a member, or unknown.
  The connection keeps syncing; the row says so and offers **Reconnect**.
- **Refuse, don't cascade.** `DELETE /v1/me/credentials/:id` answers 409 naming the workspaces and
  connectors while any connection uses it.
- **Expand/contract.** Phases 1–3 (v0.47.0) wrote `connections.credential`, `connectors.credential`,
  `github_user_tokens` and `figma_oauth_grants` as well, for the previous release, and moved the old rows
  in at boot. Phase 4 stopped writing and reading them and took them out of `schema.prisma`; the columns
  and tables are dropped one release later, because the previous image's Prisma still selects every field
  its schema declares ([versioning](../versioning.md#rollback-and-the-expandcontract-rule)). Credentials
  are `platform` in the teardown inventory.

Web: the connect dialog's sign-in step lists **Your accounts** (the caller's bindable credentials for the
provider that this workspace does not use yet) with **Use**; the Connections tab names who signed in and
flags owner-left; **Settings → Profile → Connected accounts** lists your credentials, where each is used,
**Replace token** and **Disconnect**.

## Surface

```
GET    /v1/connections?workspaceId=                 admin  list + connectors using each + live methods
GET    /v1/connections/wait?workspaceId=&since=     admin  long poll, no-store
POST   /v1/connections                              admin  a pasted token, or `credentialId` (owner only)
PATCH  /v1/connections/:id                          admin  owner's token rotates everywhere; else moves onto yours
GET    /v1/me/credentials                           self   your credentials, hints only, `usedBy`
PATCH  /v1/me/credentials/:id                       self   rotate in every workspace (same account only)
DELETE /v1/me/credentials/:id                       self   409 naming workspaces + connectors while in use
DELETE /v1/connections/:id                          admin  409 with connector names while in use
GET    /v1/connections/:id/resources?kind=&q=        admin  what it reaches, newest activity first
GET    /v1/connections/:id/branches?repo=            admin  default branch first
POST   /v1/connections/:id/links                    admin  one connector per resource↔project pair
GET    /v1/connectors/figma/authorize?workspaceId=   admin  Figma OAuth for the workspace (no connector)
```

`:id` routes resolve the workspace through the `connection` `WorkspaceSource`. Connectors take
`connectionId` on create (service) and update (DTO); the connection's provider and site must equal what
the kind and config imply. `ConnectorSummary.connectionId` says which one a connector uses.

Web: **Settings → Connectors → Connections** (`?tab=connections`; the connector list tab is now
**Connectors**), **Add connector** and a project's **Connect repository** open the connect dialog, and
`/oauth/:provider` is the landing page. Credentials never travel over MCP; `knowledge_list_connectors`
is unchanged.

## Data and rollback

Migration `20261218100000_connections` adds `connections` (no FK on workspace/user, per house policy;
unique `(workspace_id, provider, method, external_ref)` — token rows have a null ref) and
`connectors.connection_id` (FK, `ON DELETE RESTRICT`). It was additive: `connectors.credential` stayed
populated until #857 phase 4, so the previous image kept syncing against a migrated database. Workspace
teardown deletes `connections` after `connectors`; credentials stay with their owners.

## Deliberate deferrals

- The `DROP` of `connectors.credential` / `credential_hint`, `connections.credential` / `credential_hint`,
  `github_user_tokens` and `figma_oauth_grants`, unread since #857 phase 4, in the release after it.
- Workspace-owned service accounts that belong to no person, and sharing one credential between people
  (#857, out of scope).
- OAuth for Atlassian, GitLab, Notion, Google Drive, Linear, Zendesk and Intercom — each needs an app
  registered at the vendor; one issue each.
- Listing Google Drive folders (needs the adapter's private token mint) and Linear teams (no config field
  a team fills); both keep their typed fields.
- Renaming a connection; the account login identifies it.
- Deleting the setup wizard's create path, now unreachable from the UI.
- GitHub Enterprise Server hosts.

## Verification

Specs: `test/connections.spec.ts` (provider derivation, sharing never across workspaces, boot idempotency,
app/oauth rows, rebind on a new token, rotation through the connection, cross-workspace refusal, unbound
fallback, recorded installations), `test/connections-api.spec.ts` (identify, rotation, other-account
refusal, in-use delete, the links duplicate rule including 1-M / M-1 / in-request duplicates, wait
change / timeout / disconnect, install → connection), `test/figma-oauth.spec.ts` and
`test/github-partial-config.spec.ts` (callbacks land on `/oauth/:provider`), and on the web
`modules/connectors/model/oauth-landing.spec.ts` and `entities/connector/model/connection-providers.spec.ts` (no token once signed in).
