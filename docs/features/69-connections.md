# 69 — Connections

Issue: [#564](https://github.com/hrustalq/knowledge/issues/564). PRs #565 (model), #567 (API), #568 (OAuth
per connection, landing page), #569 (Connections tab, connect flow), #570 (link screen).

## What

A **connection** is one account's access to one upstream system, held by a workspace and shared by every
connector of a compatible kind. It has a `provider` and exactly one `method`:

| method  | holds                                                                                 | providers |
| ------- | ------------------------------------------------------------------------------------- | --------- |
| `token` | a pasted secret (PAT, `email:api-token`, API key, service-account JSON), secret-boxed  | all       |
| `app`   | a GitHub App installation id; syncs as the installation, browses as the person (doc 30) | GitHub    |
| `oauth` | a Figma grant id (`figma_oauth_grants`, #557)                                           | Figma     |

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
- **The connection wins, the inline credential is the fallback** — `ConnectorsService.credentialFor`
  dials through `connectors.connection_id` (token → decrypt, app → `GithubAppService.installationToken`,
  oauth → `FigmaOauthService.tokenFor` with renew) and refuses a connection from another workspace (403).
  An unbound connector dials exactly as before.
- **One writer of `connection_id` while the inline fields still exist: `bindConnection`.** It points a
  connector at the connection its own settings imply — the installation or grant in its config, else its
  token — and reuses an equal connection before creating one, comparing **decrypted** secrets (two
  envelopes of one secret never match). It runs on create, on any update that touches the credential or
  config, on the Figma OAuth bind/unbind, and in `ConnectionsBackfill` at API boot. A connector bound
  through the link flow writes the inline fields too (installation id, grant, a copy of the token
  envelope), so `bindConnection` re-derives the same connection from them.
- **Backfill at boot, not in SQL** (decided on #564). Provider derivation and equal-token detection need
  TypeScript; the migration only adds the table and the column. `ConnectionsBackfill` (API-only,
  idempotent) binds every unbound connector and turns every recorded `github_installations` row into an
  `app` connection. No separate merge pass: binding never creates the duplicate a merge would clean.
- **Saving a token identifies the account** through a cheap probe per provider
  (`adapters/connection-providers.ts`: `GET /user`, `/api/v4/user`, `/rest/api/3/myself`, `/users/me`,
  `viewer`, `/v1/me`, …; a service-account key names itself; plain `git` has no account API). A token
  upstream refuses is never stored. The same account again **rotates** that connection — and the inline
  copies its connectors keep for a rollback. `PATCH` refuses a token for another account (409): it would
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

## Surface

```
GET    /v1/connections?workspaceId=                 admin  list + connectors using each + live methods
GET    /v1/connections/wait?workspaceId=&since=     admin  long poll, no-store
POST   /v1/connections                              admin  save a token (identify; same account rotates)
PATCH  /v1/connections/:id                          admin  rotate (same account only)
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
`connectors.connection_id` (FK, `ON DELETE RESTRICT`). It is additive: `connectors.credential` stays
populated for one release and is read whenever `connection_id` is null, so the previous image keeps
syncing against a migrated database. `pruneFigmaGrants` keeps a grant a connection references. Workspace
teardown deletes `connections` after `connectors`.

## Deliberate deferrals

- Dropping `connectors.credential` — the contract half, one release after this ships.
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
`modules/connectors/model/oauth-landing.spec.ts` and `modules/connectors/model/connection-providers.spec.ts` (no token once signed in).
