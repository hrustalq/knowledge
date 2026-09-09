# 19 — Connectors

Оригинал: «implement connectors (add tab to settings) — we should be able to
connect any resource like jira, notion, obsidian, confluence, any other popular
connectable resource and be able to download / upload to them»

## What this is

A sixth section in `/settings` that makes external systems first-class,
workspace-configured **sources and destinations**. Three tabs:

| Tab             | What it does                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| **Connections** | One card per configured connection: status, direction, link count, Sync / Push / Test. |
| **Runs**        | Every sync execution with its stage, progress, counts and warnings.                    |
| **Links**       | The external item ↔ page identity map, and the ability to break one.                   |

Four adapters ship: **Confluence**, **Jira** (pull only), **Notion** and a
generic **Markdown / Git** remote. The last one is what covers an Obsidian
vault — Obsidian has no server API, and a vault is exactly a folder of markdown
files, so there is nothing else to integrate with.

Content moves on demand, on a schedule, or when the external system says
something changed.

## Why

The knowledge base was a closed world. Content got in two ways — someone typed
it, or someone uploaded a file through `/upload` (feature 16) — and nothing got
out at all: `GET /v1/documents/:id/content` was the entire read-out surface.

Real teams do not keep their knowledge in one place. The specs are in
Confluence, the tickets are in Jira, the research notes are in Notion, the
runbooks are in a vault checked into git. Exporting that by hand, page by page,
produces a copy that starts drifting the moment it lands, and there was no way
to push a correction back.

The point of a connector is that a page here and its counterpart over there are
**one page with a recorded identity**, not two copies that diverge silently.

## Decisions

**The link table is the feature.** `connector_links` maps
`(connector, external_id) ↔ document_id` and stores the `content_hash` and
`external_version` the two sides last agreed on. Without it a second pull
duplicates every page. With it, pull is idempotent, push knows what to send,
and — the part that took the most care — **the echo loop is broken on both
sides**: pull skips when the external version is unchanged, push skips when the
local head hash still equals the link's. A pull leaves the link agreeing with
what it just wrote, so the `revision.indexed` it causes cannot trigger a push,
and the webhook that push would provoke cannot trigger another pull.

**Conflicts become merge requests.** When both sides changed since the last
sync, the default policy overwrites nothing: the external version is written to
a `connector/<kind>-<id>` branch and a merge request is opened into main. Phase
3 already renders structural diffs, semantic diffs, threads and approvals over
exactly that shape, so the hardest part of two-way sync costs one branch and no
new UI. `external-wins` and `local-wins` remain available per connector for
people who want the machine to decide.

**Adapters behind one interface, reporting what they could not carry.** The
`DocumentParser` shape from feature 16: a closed catalogue in contracts
(`CONNECTOR_KIND_INFO`, read by the settings form, the create guard *and* the
worker registry, so they cannot disagree), a DI registry keyed by kind, one file
per adapter. `push` is **optional** on the interface — that is how Jira states
it is pull-only, and the UI hides its push controls off `capabilities` rather
than off a hard-coded list. Every adapter returns `warnings[]`: Confluence names
the macros it dropped, Notion names the block types with no markdown
equivalent, the git adapter names the wiki-links that will not resolve outside
their vault. A lossy sync that says nothing is the failure this feature exists
to prevent.

All four talk plain `fetch` — the house pattern (`ArcadeClient`, the OpenSearch
client), no per-vendor SDK. Only one dependency was added: `marked`, for the
markdown → HTML that Confluence's storage format needs on the way out.

**Setup is a scenario, not a form.** The dialog was first written as one long
form — every field for every kind at once — and it could not say which half the
credential had to be right for, so the only way to discover a mistyped token was
to save and watch a red row appear. It is now a wizard driven by xstate
(`apps/web/src/components/connectors/setup-machines.ts`), in the two layers
`@knowledge/workflow` established:

- **A per-kind machine** declares that kind's own questions and nothing else.
  Confluence asks for a site and then a space; Notion asks one optional
  question; a git remote asks for a repository and then a branch and folder.
  These differ because the systems differ, so they are declared separately
  rather than switched on inside one step.
- **A core wrapper** owns the spine every kind shares — name, test, destination,
  what-it-does, submit — and invokes the per-kind machine as a child.

The flow is **resumable**: `getPersistedSnapshot()` persists the wrapper *and*
its invoked child, so a reload lands back on the step you left, with the child's
sub-step intact. The snapshot is plain JSON, which is what would let it move
server-side later; today it lives in `localStorage`. Testing the connection
saves a **disabled draft** connector first, because a test needs a row — which
also means that from the test onward the setup has an id, not just a snapshot.

A failed test is its own state rather than a flag, with three honest exits: fix
it, go back, or continue knowing it does not work. A connector that cannot
connect simply will not sync; refusing to let anyone past that screen would be
worse.

**The worker writes pages, the API opens merge requests.** A pull writes
documents in bulk, and `DocumentsModule` cannot load in the worker: it carries
controllers, and `MergeRequestsService` injects `AccessService` from the global
`AuthModule`. Feature 17 solved that with an API-side materialize sweeper, which
is right for a rare path and wrong for bulk — a 500-page pull would trickle
through a sweep interval. So `DocumentsService` was split into a controller-free
`DocumentsCoreModule` (with `ProjectsCoreModule` and `ActivityCoreModule` under
it), each existing module importing and re-exporting its core so no call site
changed. Conflicts, being the exceptional path, *do* use the feature-17 sweeper.

**Webhooks verify before they do anything.** `POST /v1/connectors/:id/webhook`
is `@Public()` — the caller is GitHub or Atlassian and has no session — and its
authentication is the connector's own HMAC secret checked against the **raw**
body (`rawBody: true` in `main.ts`; Express has parsed and discarded the
original bytes by handler time, and re-serialising would not reproduce them). It
enqueues and nothing else: a webhook endpoint that syncs inline is a
denial-of-service surface with a public URL. A burst of edits **coalesces** into
the run that is still queued rather than being refused — a running run's scope
is frozen, so refusing would silently drop those items until the next full sync.

**Credentials reuse `secret-box.ts` unchanged** (AES-256-GCM, `gcm$iv$tag$ct`,
fail-soft decrypt, same `SETTINGS_ENCRYPTION_KEY`), write-only over the API with
a last-4 hint. The SSRF guard that was inside `mcp-client.service.ts` moved to
`common/safe-url.ts` and is now called by both plugins and connectors — one
implementation of an SSRF filter is the only safe number.

## Surface

```
GET    /v1/connectors?workspaceId=        viewer
POST   /v1/connectors                     admin
GET    /v1/connectors/runs/:runId         viewer   (before :id, or :id claims "runs")
GET    /v1/connectors/:id                 viewer
PATCH  /v1/connectors/:id                 admin    (null clears a credential, absent keeps)
DELETE /v1/connectors/:id                 admin    (pages it created are kept)
POST   /v1/connectors/:id/test            admin
POST   /v1/connectors/:id/sync            editor
GET    /v1/connectors/:id/runs            viewer
GET    /v1/connectors/:id/links           viewer
DELETE /v1/connectors/:id/links/:linkId   editor
POST   /v1/connectors/:id/webhook         public, HMAC-verified
GET    /v1/documents/:id/connectors       viewer
POST   /v1/documents/:id/push             editor
```

New `WorkspaceSource` values `connector` / `connector-run`. MCP gained
`knowledge_list_connectors`, `knowledge_sync_connector`,
`knowledge_get_connector_run`.

## Deliberate deferrals

- **Jira is pull-only.** Authoring Atlassian Document Format is its own piece of
  work; reading is easy because the API renders it to HTML for us
  (`expand=renderedFields`), writing is not.
- **`markdown-git` pushes only to GitHub and GitLab.** Other hosts have no
  common contents API, so those repositories are pull-only. Pull works
  everywhere that serves a repository archive over HTTPS.
- **Notion push covers a documented block subset.** Anything outside it is
  reported as a warning rather than silently dropped.
- **Attachments are not pulled yet.** The adapter interface carries
  `attachments` and the import feature already has the promote-to-attachment
  path; wiring the two together is the obvious next step.
- **No OAuth.** Every adapter takes an API token or PAT, which is what these
  systems issue from a settings page and needs no app registration or callback.

## Verification

There is no test suite; verification is `make check` plus the end-to-end flow.
`apps/web/src/components/connectors/setup-machines.check.ts` is a plain assert
script for the wizard's transitions, persistence round trip and stepper
arithmetic:

```bash
node --experimental-strip-types \
  apps/web/src/components/connectors/setup-machines.check.ts
```

The single most important manual check is **syncing twice**: the second run must
report every item as unchanged, create nothing, and produce no duplicate pages.
