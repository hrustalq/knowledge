# 36 — GitHub access: granted permissions and re-authorisation

Оригинал: «we also have to add auth re-setup via github oauth page and list
granted permissions»

## What

A **GitHub access** card on the connector page (`/settings/connectors/:id`),
for admins, on any connector whose repository is on github.com. It answers the
three questions a person fixing a GitHub problem has, in one place:

1. **What has this installation granted?** Every permission and webhook event
   the installation has, beside what the App registration asks for and what
   this connector's features need — each row saying which feature uses it
   (sync, publishing, work items, drift check, boards, workflow triggers).
2. **Which GitHub account am I linked as?** The viewer's own identity, whether
   its authorisation has lapsed, and **Reconnect** / **Disconnect**.
3. **Where do I fix it?** **Review on GitHub** opens the installation's page,
   where an owner accepts new permissions; **Edit the App** opens the App
   registration, when something needed is not even requested.

## Why

Features 32 and 35 each asked the App for more — issues, pull requests, more
events — and GitHub does not hand an existing installation new permissions: the
App asks, and each installation's owner must accept. Until they do, the feature
silently does not work: a drift check whose comment is refused, a work-items tab
that cannot open an issue. Nothing in the product said which permission was
missing or whose job it was to grant it, and the only way to find out was to
read GitHub's settings pages side by side with our docs.

Re-authorisation had the same gap. The OAuth identity (feature 30) is linked
once, from the repository picker, and there was no way to relink it after it
lapsed or to switch to a different GitHub account.

## Decisions

**Two different fixes, so two different statuses.** A permission the App
*requests* but the installation has not accepted is **pending** — the
installation's owner clicks accept on GitHub. One the App does not request at all
is **missing** — whoever owns the App registration adds it, and then every
installation accepts. Collapsing them would send people to the wrong page. The
card reads both sides as the App (`GET /app/installations/:id` and `GET /app`,
with its JWT), so it works for an admin who has never linked a GitHub account.

**Needs are computed from what the connector actually does.** The catalogue in
`connectors/github/github-access.ts` is the one place a feature's GitHub needs
are written down. A requirement counts as **active** only when the connector
uses its feature — publishing only for a `markdown-git` connector that pushes,
the drift check only when it is on — and only an active gap is flagged. Boards
and workflow triggers are never active: a board name is decoration, and a repo
event matters only to a workflow somebody may not have written. An inactive gap
is shown, muted; a grant nothing here uses is listed as *extra*.

**Reconnect forces the account picker.** GitHub's authorise page waves an
already-authorised browser straight through as whichever account it is signed
in to, which is the wrong behaviour for a reconnect whose point may be to
switch accounts. `prompt=select_account` makes GitHub ask. The OAuth state
carries this page as its return path, so the callback lands the person back on
the card, which says how it went (`?github=connected | auth-failed |
install-failed | error`) once as a toast and removes the parameter.

**Disconnect is per-person.** `DELETE /v1/connectors/github/identity` has no
`@Access`: the identity row is keyed by user, so there is no workspace to check
and nothing anybody else can be refused. It forgets the caller's token only —
installations are the workspace's, and syncs keep running on them.

**No caching.** Both reads happen when an admin opens the card; a cached copy
would hide the permission they have just accepted. The card refetches when the
tab regains focus after either GitHub link, the picker's rule.

## Surface

```
GET    /v1/connectors/:id/github        admin   → ConnectorGithubAccessResponse
DELETE /v1/connectors/github/identity   authenticated
```

`GithubOauthService.authorizeUrl` gained `{ selectAccount }` and
`redirectUri()` (lifted from the controller so the card and the picker build
the same one). `GithubAppService` gained `installationGrant()` and
`registration()`. No migration, no env var.

## Deliberate deferrals

- **Personal access tokens are not inspected.** A classic token's scopes are in
  a response header and a fine-grained token's permissions are not readable at
  all; the card says the connector uses a token and points at the App instead.
- **GitLab.** There is no App model to compare against; a project token's
  scopes would be a different card.
- **Accepting permissions from here.** GitHub offers no API for it, by design —
  it is the owner's decision on github.com.

## Verification

`apps/api/test/github-access.spec.ts`: pending vs missing, needs that follow the
connector's active features, a stronger grant satisfying a weaker need, extras,
problem-first ordering, and events. The card was checked in the browser in its
unconfigured state against the local stack, and with representative grants
injected into its query cache for the populated layout. Reading real grants
needs a registered App, which only production has.
