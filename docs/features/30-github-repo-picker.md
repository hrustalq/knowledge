# 30 — GitHub repository picker

Оригинал: «let's implement a full github repo picker (should also consider we
support user's orgs) like on vercel / claude consoles»

## What

The `codebase` and `markdown-git` connectors stop asking for a URL, a branch and
a personal access token, and start asking **which repository**. A GitHub App is
installed once per workspace; the wizard's repo step then shows an account/org
switcher, a searchable repository list, and a branch dropdown defaulted to the
repository's own default branch.

The picker is optional. With `GITHUB_APP_ID` empty the wizard is exactly what it
was, and every connector already configured with a token keeps working —
unchanged, not merely supported.

## Why

Three free-text fields, each able to be wrong in a way the form could not catch,
and a 404 that could not tell you which one was ([#28](https://github.com/hrustalq/knowledge/issues/28)):

| What was wrong        | What the operator saw       |
| --------------------- | --------------------------- |
| Repository misspelled | `404: Not Found`            |
| Repository private    | `404: Not Found`            |
| Branch does not exist | `404: Not Found`            |

GitHub masks "no access" as 404 rather than 401, deliberately, so no amount of
reading the response separates the first two from the third.

The token was the other half of the problem. A PAT that can read one repository
can read every repository its owner can — there is no narrowing it — and during
creation it sat in browser memory and in the wizard's `localStorage` snapshot.
An App installation is the opposite shape: the org owner grants specific
repositories, and the token our side holds is minted per run and dies within the
hour.

## Decisions

**Two credentials, because they answer different questions.** A GitHub App has
an installation identity and a user identity, and this feature needs both for
reasons that do not overlap:

- **Browsing acts as the user.** The account switcher must show the orgs *this
  person* can reach. `GET /app/installations` lists every account the App is
  installed on — across every customer — so a switcher built on it would offer
  people orgs they have nothing to do with. `GET /user/installations` answers
  the question actually being asked, and needs an OAuth token.
- **Syncing acts as the installation.** It is server-to-server and outlives
  whoever configured the connector, so a scheduled sync keeps working after that
  person's OAuth token expires, their account is deactivated, or they leave.

Using one for both would break something real in either direction: sync as the
user and a departure breaks the connector; browse as the App and the switcher
leaks org names.

**The result is intersected with the workspace.** An installation the person can
see but their workspace never recorded is dropped, and vice versa. Connecting a
personal GitHub account must not silently widen a workspace to every org that
person happens to belong to.

**One seam, no adapter changes.** `ConnectorsService.contextFor` resolves
`credential` to a freshly minted installation token when `config.githubInstallationId`
is set, and to the stored PAT otherwise. Every adapter already reads
`ctx.credential`, and `githubHeaders` already sends it as a bearer token, so
nothing below that line knows which of the two it got. The alternative — a
`GithubInstallationAdapter` beside the existing two — would have duplicated the
archive download, the file filter and the module mapper to change one header.

**No JWT library, no Octokit.** An App JWT is RS256 over two base64url segments,
which `node:crypto` signs in three lines. The house rule that adapters talk
plain `fetch` with no per-vendor SDK is not arbitrary here: the whole GitHub
surface this feature touches is six endpoints.

**The callback is `@Public()` and the signed `state` is the whole gate.** GitHub
redirects a browser carrying no session of ours. Without state verification,
anyone who could reach that URL could bind an installation of their choosing to
a workspace of their choosing — so the HMAC covers the workspace, the user and
an expiry, and every path verifies it *before* touching the database.
`test/github-jwt.spec.ts` is mostly tampering cases for that reason.

**One route serves both redirect URLs.** The handler reads `code` and
`installation_id` independently rather than as an either/or, because GitHub's
first install with "request user authorization" on sends both in one request.

**Empty branch stays a real choice.** The picker seeds the repository's current
default rather than pinning it, and clearing the field means "follow the
default" — which `resolveBranch` now honours server-side. A connector left on it
survives a default-branch rename; a pinned one stops. The dropdown labels both.

## Surface

```
GET /v1/connectors/github/installations?workspaceId=   admin
GET /v1/connectors/github/repos?workspaceId=&installationId=&q=       admin
GET /v1/connectors/github/branches?workspaceId=&installationId=&owner=&repo=  admin
GET /v1/connectors/github/callback                     public, state-verified
```

Browsing is `admin`, matching the rest of connector configuration: a repository
list is the shape of a credential's reach, not an ordinary viewer read. The
three reads return an `{ok, items[], error?}` envelope and never throw — they
answer "what can I see", and an upstream hiccup is something for the picker to
render.

`GithubController` is separate from `ConnectorsController` because every path
here is a literal segment, and that controller already has to declare literals
ahead of `@Get(':id')` to stop `:id` claiming them.

## Setup

Register at `https://github.com/settings/apps/new`:

| Field                                     | Value                                              |
| ----------------------------------------- | -------------------------------------------------- |
| Callback URL **and** Setup URL            | `$API_PUBLIC_URL/v1/connectors/github/callback`     |
| Request user authorization during install | on                                                  |
| Redirect on update                        | on                                                  |
| Webhook → Active                          | **off**                                             |
| Repository permissions → Contents         | Read-only (Read and write to push back)             |

Then fill the `GITHUB_APP_*` block in `.env`. The private key is a multi-line
PEM and `.env` cannot hold newlines, so pass base64 of the whole file:
`base64 -i your-app.private-key.pem | tr -d '\n'`.

Webhooks are unrelated to this feature and unchanged: they stay per-connector at
`/v1/connectors/:id/webhook` with that connector's own HMAC secret, because an
App-level webhook has no way to know which connector an event belongs to.

## What #28 changed underneath

Both fixes live in `repo-archive.ts` and apply to every host, picker or not:

- `resolveBranch` — an empty Branch field means the repository's real default,
  cached per run beside the archive promise. An explicit branch costs no request.
- A 404 from the archive probes `/repos/{owner}/{repo}` **once, on the failure
  path only**, and says either "not found, or the credential cannot read it" or
  `branch "main" does not exist — its default branch is "dev"`.

`blobUrl` gained an explicit `branch` parameter rather than resolving one,
because resolution is now async and it is called per file.

Note that `CodebaseAdapter.testConnection` was never the problem: it has no
try/catch, so the 404 already reached the dialog. Its `no source files were
found` message fires only when the archive downloaded fine and zero files
matched — a different failure, correctly worded.

## Deliberate deferrals

- **GitHub only.** GitLab and self-hosted remotes keep the URL + token path.
  They still get the better error messages.
- **No migration of existing PAT connectors.** Repointing one at an installation
  is a re-pick in the wizard, and doing it automatically would mean guessing
  which installation an existing URL belongs to.
- **Installation tokens are cached in memory, not Redis.** They are worth an
  hour, minting one is a single request, and a shared cache would put a live
  repository credential in a second system for no gain.
- **GitHub Enterprise Server is untested.** `GITHUB_API_URL` exists and the
  OAuth hostnames are still hardcoded to github.com.

## Verification

`make verify`, plus `apps/api/test/repo-archive.spec.ts` (10 cases over branch
resolution and 404 classification) and `apps/api/test/github-jwt.spec.ts` (12
over key parsing, the App JWT and state tampering).

The manual check that matters is **the fallback**: with `GITHUB_APP_ID` empty,
the wizard must show the old Repository URL and token inputs and save a working
connector. The picker is the new path, not the only one.
