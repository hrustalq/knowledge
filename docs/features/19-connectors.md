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

Four adapters shipped first: **Confluence**, **Jira** (pull only), **Notion** and a
generic **Markdown / Git** remote; **Confluence Server**, **Codebase** and
**Google Drive** (#338, pull only) came later. The last one is what covers an Obsidian
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

## Access mirroring (#76, phase 6)

A connector can carry who may open each page at the source onto the page here.
Off by default (`connectors.acl_mode = 'off'`), which is the behaviour before
the milestone, byte for byte.

**One ACL engine.** A mirrored ACL is an ordinary page restriction:
`documents.restricted = true` plus `access_grants` rows with
`origin = 'connector'` and the connector's id. From there `restricted_by`, the
re-stamp sweeper, search, the graph, the assistant, notifications and MCP all
apply it unchanged; nothing connector-specific touches ArcadeDB or OpenSearch.

**Modes** (`CONNECTOR_ACL_MODES`):

- `mirror` restricts a page whose source is restricted to the mapped people and
  mirrored groups it names. Principals with no person here are left out, listed
  on the connector's **Access** tab and in the staged item's warnings.
- `mirror_strict` does the same and also admits the connector's owner on any
  page that names someone unmapped, so a page is never readable only by admins
  when the mapping is incomplete.
- In both, a page whose ACL could not be read is restricted to the owner when
  it is created. A page already mirrored keeps its last ACL through a failed
  re-read: one upstream error neither opens nor locks a page.

**Adapter contract.** `permissions?(ctx, ref): Promise<ExternalAcl>` and
`groupMembers?(ctx, group)`, present exactly when `capabilities.acl` is true.
`ExternalAcl` is `{ audience: 'source-wide' | 'restricted', principals }`. The
adapter folds the source's inheritance into that one list
(`adapters/acl-layers.ts#combineLayers`): one restricted layer is kept as is,
groups included; several are intersected person by person, groups expanded to
their members, the weaker level winning. A flat import (no
`preserveHierarchy`) therefore reads correctly without its ancestors here.
Groups are read lazily, per group an ACL names, rather than enumerated: a
Confluence site holds thousands that no page in scope mentions. *(The plan had
`groups?(ctx): AsyncIterable<ExternalGroup>`.)*

| Source | ACL |
| --- | --- |
| Confluence Cloud / Server | Read restrictions on the page and every ancestor, intersected. Space permissions are **not** read: restrict the destination project to narrow a space's readers. Cloud identifies people by `accountId` (email only where the profile shows it); Server by `userKey`, with no email, so Server people are mapped by hand. |
| GitHub (`markdown-git`, `codebase`) | Public repository → `source-wide`. Private → collaborators (`affiliation=all`; push/maintain/admin → edit, pull/triage → view) plus teams, mirrored as groups. Team members need the App's `members: read`, which the GitHub access card lists under *access mirroring*. One read per run, shared by every page. GitLab and other hosts are refused when mirroring is switched on. |
| Google Drive | Each file's own permission list, which Drive already folds folder and shared-drive inheritance into: one layer, nothing to intersect. Link sharing (`anyone`) and whole-domain sharing → `source-wide`. People and groups are keyed by lower-cased email — the one id the Drive and Directory APIs share; the service account itself is left out. Group members come from the Admin SDK Directory API and need domain-wide delegation (`subject` set to an admin); without it a group mirrors with no members, which narrows a page rather than widening it. |
| Notion, Jira | No per-item ACL. Mirroring restricts every page to one workspace group, `connectors.acl_audience_group_id`, required while it is on. |

**Identities.** `external_identities` holds every upstream person an ACL or a
group named, mapped or not. Resolution, strongest first: a mapping by hand
(never overwritten), a linked GitHub account (`github_user_tokens`), a
**verified** email (`users.email_verified_at`). Only workspace members resolve.
Mirrored groups are `user_groups` rows with `source = 'connector'`, named
`<connector> · <group>`, read-only in the UI, membership replaced on each sync.

**Where it runs.** Where the content does, in the worker: staging reads the ACL
before either skip (an unchanged page still mirrors a permission change),
stores it on `connector_run_items.acl`, shows unmapped principals as item
warnings, and `apply` writes it — for a new page, in the transaction that
creates the page, so a private page is never open for a tick. The ACL-only
refresh is a due check in `ConnectorScheduleSweeper`
(`acl_synced_at + interval`, default `CONNECTOR_ACL_SYNC_DEFAULT_MIN`) that
queues one `acl` job per connector (jobId `acl-<id>`, so a manual "sync access
now" and the tick collapse). It re-resolves people, refreshes group members,
then re-reads every linked page's ACL — permission calls only.

**What is never overwritten.** `connector_links.acl_hash` is the hash of the
restriction as written, after mapping, so a new mapping is a change even when
nothing moved upstream. A sync rewrites only its own connector's grants. It
lifts only a restriction it placed (`connector_links.acl_restricted`) and only
while no manual grant is left on the page; a switch a person turned on stays
on. A mirrored restriction lifted by hand is put back on the next sync. The
page Access dialog shows mirrored grants read-only and never sends them back.

**Turning it off, or deleting the connector,** hands what it mirrored to
people (`releaseMirroredAccess`): its grants become manual grants and its
groups manual groups, exactly as they stand. Nothing opens up, and nothing is
left that the API refuses to edit.

**Limits.** No space-level Confluence permissions; no Slack (lands with the
conversation sources) or Jira issue security. A mapping by email is only as
good as email verification until IdP-verified identities arrive with the
*Enterprise auth* milestone. Mirrored grants do not send `access.granted`
notifications: a sync is not a person's decision.

## Google Drive (#338)

A seventh adapter, `google-drive`, and the first whose source is a folder tree
of *files* rather than a wiki of pages. Pull only and no webhook (Drive push
notifications need a verified domain).

**Authentication is a service account.** The credential is the account's JSON
key, through `secret-box.ts` like every other credential (the DTO's
`credential` limit went from 2 000 to 8 000 characters to fit one). The adapter
signs an RS256 JWT with `node:crypto` and trades it for a one-hour token per
scope — no Google SDK. The token URL is fixed at
`https://oauth2.googleapis.com/token`, never the key's own `token_uri`: that is
a URL an admin pasted, and this server would dial it with a signed assertion.
Every call still goes through `connectorFetch`, so the SSRF guard runs at the
dial. `subject` (*Act as user*) is domain-wide delegation: Drive is read as
that person, and it is what reading Google Groups needs.

**Scope is one folder or shared drive** (`folderId`). A shared drive's id is
its root folder's id, so one field serves both; the adapter notices a shared
drive and adds `corpora=drive&driveId=…` to every listing and to the change
feed. Ids are checked against `[A-Za-z0-9_-]` before they reach a `q=` query.

**Tree.** `children()` lists one folder; folders yield `hasChildren: true`.
With `preserveHierarchy` a folder becomes a page with no body, so its files
have somewhere to hang — unlike a git connector's transparent directories,
Drive folders are real objects people name and share. The connector's own
folder is not a page; its contents land under the connector's destination.

**Conversion is feature 16's.** `importFormatFor` decides what a file is, and
`ParserRegistry` converts it, so a Drive file imports exactly as the upload
wizard would import it. Google-native files are exported first: Docs → DOCX,
Slides → PPTX, Sheets → CSV (first sheet only, said on the page). Images are
*not* imported: their parser is OCR, which bills a model per file, and an
unattended sync must not run up a bill on a folder of screenshots. Unsupported
and oversized (> 20 MB) files are skipped and named in one run warning per
folder, through the new optional `ConnectorContext.warn`. Images inside a
document are dropped with a warning, the attachment deferral below.
`ParsersModule` therefore loads in the API process too (the adapters module is
shared); only a sync run, in the worker, ever calls `parse`.

**Change detection is the Changes API**, through a second optional adapter
method, `changes?(ctx, cursor)`, and a cursor column on the connector and on
the run:

- Every pull of a kind that has `changes()` reads the feed *before* it walks.
  With no stored cursor that is just a bookmark (`startPageToken`), so whatever
  changes during the walk is picked up next time rather than lost.
- The cursor goes on the run and is copied to `connectors.change_cursor` only
  in `finish()`: a run that fails or is cancelled leaves the bookmark, and the
  next one re-reads the same changes.
- A **scheduled** pull with a stored cursor seeds its run from the feed alone —
  no folder listing, no orphan repair — so a quiet folder costs one request.
  A **manual** Sync still walks the whole tree, and the version skip keeps
  that cheap; on a second sync every item is `unchanged`.
- A refused cursor (expired, revoked) falls back to the walk with a fresh one.
- The feed covers everything the account sees, so a changed file is kept only
  if its ancestry reaches the folder (memoised per read).

**Gone upstream.** A linked file the feed reports trashed, deleted, unshared or
moved out of the folder becomes an `unchanged` row carrying why, and one run
warning counts them. The page is kept and so is its link: deleting a page is a
person's decision, and a file restored from the bin updates the same page
rather than creating a second one. Its mirrored ACL stays as last written (the
rule for a failed re-read).

## Harvest connectors (#382)

`linear` (#382), `zendesk` (#383) and `intercom` (#384) are connector kinds that move no content: `capabilities`
has `harvest: true` and `pull`/`push` false, so there is no Sync button, no
runs and no destination tree. The webhook says when an issue was completed
or a ticket solved, and a resolved item carrying the connector's harvest
label (a Zendesk or Intercom tag) becomes reviewed captures in the name of whoever
resolved it. The whole contract (trigger,
attribution, what is read, the `connector_harvests` claim and its sweeper) is
in [59 — Chat harvest](59-chat-harvest.md#trackers-and-help-desks-382384).
The setup dialog asks for the API key, the label, and the webhook's signing
secret, and skips the sync questions for such a kind.

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
GET    /v1/connectors/:id/acl             admin    (mode, interval, audience, identities)
PUT    /v1/connectors/:id/acl             admin    (off hands mirrored access to people)
PUT    /v1/connectors/:id/acl/identities/:identityId  admin  (map by hand; null re-resolves)
POST   /v1/connectors/:id/acl/sync        admin    (queue an ACL-only refresh)
GET    /v1/documents/:id/connectors       viewer
POST   /v1/documents/:id/push             editor
```

New `WorkspaceSource` values `connector` / `connector-run`. MCP gained
`knowledge_list_connectors`, `knowledge_sync_connector`,
`knowledge_get_connector_run`.

A connector belongs to its destination project and follows that project's
visibility (#555, the `canSeeProject` rule of #553). The list — REST and
`knowledge_list_connectors` — drops connectors in a project the caller cannot
open, and every `connector` / `connector-run` route and tool answers one with
404 after the role check (`PermissionService.requireConnectorVisible`, called by
`AclGuard` and the MCP guard), naming neither the project nor the connector. A
workspace admin bypasses restrictions and sees them all; an unrestricted
project costs one indexed read and no scope.

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
