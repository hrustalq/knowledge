# 56 — Real-time co-editing of drafts

Issue [#80](https://github.com/hrustalq/knowledge/issues/80), shipped as seven
PRs: the phase 0 spike (#306), phases 1–5 (#307–#311) and phase 6 (the one
carrying this document). **Off by default**: `COLLAB_ENABLED=false` is today's
single-user editor, unchanged.

Before this, one page had one editor at a time. Two tabs on the same page
wrote the same localStorage working copy ([03](03-editor.md)), last write won,
and two people found out about each other through a 409 on publish. Every
serious wiki lets several people edit one page at once, with live cursors.
Ours has to do it without giving up the rule that a revision is immutable
([02](../architecture/02-persistence-revisions.md)).

So the shared thing is not a revision. It is a **draft**: one Yjs document per
(page, branch), edited by everyone who has the page open, stored as mutable
state beside the revisions. **Publish** turns what the draft holds into an
ordinary revision through the existing `If-Match` → presigned PUT → finalize
path, and the draft carries on from there.

## What

- **Typing reaches everyone on the page** as it happens: the body and every
  page field (title, tags, category, parent, project, relations and the
  revision message). Other people show as faces in the editor header and as
  carets labelled with their name, in their avatar colour.
- **A status dot** says where this tab stands: live, offline (edits stay on
  this device and sync on reconnect), connecting, or stopped and why
  (signed out, no access any more, draft too large, co-editing switched off).
  A viewer joins read-only. So does a tab whose editor build is older than the
  server's schema, with a "reload to edit" note.
- **"Unpublished changes"** opens the diff of the draft against the published
  page. Publishing writes one revision on the draft's branch and credits
  everyone who wrote in the draft since the last publish as co-authors, shown
  as faces in the revision history. Edits someone makes after you press
  Publish stay unpublished; they are neither lost nor claimed.
- **Someone published another way** (MCP, a merge, a connector): the editor
  says so as it happens, the review diffs the draft against what they
  published, and you choose **Publish on top** or **Discard draft**.
- **Discard** resets the draft to the published page for everyone in it, on
  every API instance, and clears each browser's offline copy, including a
  browser that was offline when it happened.
- **Branches.** `/documents/:id/edit?branch=<name>` edits that branch's draft.
  A feature branch's draft is how a group works on a proposed change before
  opening a merge request.
- **Badges.** The document page and an open merge request show who has a
  branch's draft open and whose changes are unpublished. On a merge request
  this is a warning, never a merge gate.
- **The editor assistant's suggestions are shared**
  ([34](34-editor-assistant.md#in-a-shared-draft-80)): everyone sees one as it is
  written, credited to the agent and the person who asked, and any editor may
  keep or discard it.

## How it works

### One draft per branch

`collab_drafts` (`apps/api/prisma/schema.prisma`, `CollabDraftsService`) holds
one row per (document, branch): the encoded Y state, a Y snapshot of it, the
`published_snapshot` it is compared with, the base revision, the contributors
since the last publish, and `reset_at`. **It is not a `DocumentRevision`**;
those stay immutable, and a revision in status `draft` is still only "row
exists, bytes not uploaded yet".

The Y.Doc has three parts:

| Part | Type | Holds |
| --- | --- | --- |
| `body` (`BODY_FIELD`) | `Y.XmlFragment` | The page, bound to the editor by Tiptap Collaboration |
| `meta` (`META_FIELD`) | `Y.Map` | Page fields: `title`, `tags`, `message` as `Y.Text` (two people can type in one), the rest as last-writer-wins values (`@knowledge/editor-schema/page-fields`) |
| `suggestions` | `Y.Map` of `Y.Map` | The assistant's pending suggestions ([34](34-editor-assistant.md#in-a-shared-draft-80)) |

**The server seeds a draft once**, from the branch head, the first time anyone
opens it. `packages/editor-schema` is the editor's node specs and markdown
parser without the Vue node views, so the API builds the editor's exact schema
under jsdom (no scripts, no network) and turns the head's markdown into Y
state. Every instance with a peer may try at once; the insert is guarded
(`ON CONFLICT DO NOTHING`) and every instance adopts the row that won, because
two seeds merged into one doc would show the page twice.

**Storing** is Hocuspocus's debounced `onStoreDocument`: the full state, every
`COLLAB_STORE_DEBOUNCE_MS` and at least every `COLLAB_STORE_MAX_DEBOUNCE_MS`
under continuous typing, on the instance the edit arrived at (updates relayed
over Redis skip the hook, so two instances do not write twice). The store
credits the writer from the connection's principal, never from the client, and
refuses a state larger than `COLLAB_MAX_DOC_BYTES`: the peers close with
`too-large`, and the last stored state stays.

**Checkpoints.** `CollabCheckpointSweeper` (API-side, fixed tick, no cron)
copies a draft edited since its last checkpoint to MinIO at
`workspaces/{ws}/documents/{doc}/drafts/{branch}/checkpoint.ydoc`, at most
every `COLLAB_CHECKPOINT_INTERVAL_MINUTES`, and keeps the newest
`COLLAB_CHECKPOINT_KEEP` versions of that one key. A guarded claim makes one
instance write it. The same sweeper drops drafts that hold nothing unpublished
and that nobody touched for `COLLAB_DRAFT_RETENTION_DAYS`. A draft with
unpublished changes is never dropped.

### The socket

`/v1/collab` is a second `@WebSocketGateway` beside `/v1/events/ws`, on the
same `WsAdapter` and port (`apps/api/src/collab/collab.gateway.ts`). It embeds
`@hocuspocus/server` as a library and hands it each socket.
`@hocuspocus/extension-redis` relays updates and awareness between instances
on its own connections, so CRDT traffic never rides the best-effort
`knowledge:events` bus. `CollabModule` is API-only; dependency-cruiser keeps it
out of the worker and the stdio MCP entrypoint. The HTTP MCP module runs in the
API and imports it for the draft tools ([below](#mcp-agents-in-a-draft)).

A doc name is `collab:{workspaceId}:{documentId}:{branchId}` (`collabDocName`).
The workspace part is never trusted: admission resolves the workspace from the
document in PG and checks that the branch is the document's.

**Admission** (`onAuthenticate`, per document, because Hocuspocus multiplexes
documents over one socket):

1. The token is `collabToken(ticket, generation)`: a single-use `kt_` URL
   ticket (`POST /v1/auth/url-ticket`, 60 s) and nothing longer-lived, so no
   session token or API key ever crosses the socket. A fresh ticket is minted
   for every (re)join.
2. Page permissions decide ([48](48-page-permissions.md)): view to join, edit
   to write. Without edit the connection is read-only, and Hocuspocus drops
   its updates server-side. A read-only API key lands there too.
3. A device copy from another seeding of the draft is refused with `reset`
   (see [Generations](#discard-and-generations)).

Every per-document outcome is a **reason**, not a close code
(`COLLAB_DENY_REASONS`: `unauthorized`, `forbidden`, `access-changed`,
`too-large`, `reset`). A refused page never names itself. The only socket close
code is 4503, when the flag is off. The provider never rejoins by itself after
a reason; the client's `outcomeOf` decides whether to rejoin or stop.

**A connection outlives its ticket**, so it is re-judged on `acl.changed` for
its workspace and every `COLLAB_REAUTH_INTERVAL_SECONDS` (the only path that
sees a plain role change). A revoked key, an ended session or a disabled
account closes with `unauthorized`. A page restricted away closes with
`forbidden`. Gaining or losing edit closes with `access-changed`, and the
client rejoins in its new scope rather than typing into a connection whose
writes are dropped.

**Identity is the server's word.** Every awareness update a connection sends
has its `user` fields (`userId`, `name`, `avatarUrl`) overwritten from the
connection's principal (`beforeHandleAwareness`). A caret's name and colour
come from there.

### Publishing

The editor's publish (`EditorPage.save()`):

1. reads the draft's id and base from `GET :id/drafts`;
2. calls `seal()`, which clears the revision `message` for everyone (it
   belongs to the revision, not the page) and takes a Y snapshot;
3. serializes the body in the same tick, so nothing lands between the snapshot
   and the markdown;
4. sends `POST :id/revisions` with `collabDraftId`, `draftSnapshot` and
   `If-Match: <base>` (or the moved head for Publish on top), then the usual
   PUT and finalize.

`finalizeRevision` rebases the draft inside its existing transaction, on the
dedupe path too: the base becomes the new revision, the snapshot becomes
`published_snapshot`, and the contributors become the revision's
`coAuthorIds`. "Unpublished" is `snapshot ≠ published_snapshot`, decoded with
`Y.equalSnapshots`. It is a snapshot and not a state vector, because a state
vector does not move on a deletion. Publishing is refused while anyone's
assistant suggestion is undecided.

When the head moves by another path, the editor hears `revision.finalized`
and compares the head with the draft base. A 409 on publish takes the same
path: notice, review diff against the new head, then **Publish on top** or
**Discard draft**. There is no automatic content merge; the diff review is the
only safeguard ([02](../architecture/02-persistence-revisions.md#limits)).

### Discard and generations

`DELETE /v1/documents/:id/drafts/:branchId` (editor) reseeds the row in place
from the branch head and moves `reset_at`. It publishes `draft.reset`, and
every instance's gateway closes that draft's peers with `reset`. Three guards
keep the old draft from coming back:

- **Stores are guarded on `(id, reset_at)`.** A doc loaded before the reset
  can never write over the reseed. A refused store closes its peers with
  `reset` too, so a lost `draft.reset` event heals itself.
- **Admission waits for a reset doc to unload** (`settled`), so a peer that
  rejoins at once gets the reseed rather than the doc it was closed out of.
- **Generations** (phase 6). Each draft row has a generation,
  `generationOf(row)`: its id and `reset_at`, so a reset and a dropped-then-
  reopened draft both make a new one. After a peer joins, the server sends it
  the generation as a stateless message (`CollabJoined`). The browser keeps it
  beside its IndexedDB copy (in y-indexeddb's key–value store, outside the
  Y.Doc, so it never syncs) and sends it back in its token on every join. A
  copy from another generation is refused with `reset` **before its sync step
  is read**. The client then clears the copy and reopens the page. This covers
  a browser that was offline when someone discarded the draft, whether it
  reopens the page later or held it open throughout. Without it, that copy
  would merge the old page, and any stale suggestions, into the reseed.

On `reset` the web drops its Y.Doc and IndexedDB copy (`forget()`), says the
draft was discarded, and reopens the page from the start.

### Offline

`use-collab.ts` keeps an IndexedDB copy per doc name (`y-indexeddb`). Edits
made while the socket is down land in it and sync on reconnect; Yjs merges
them, so an offline edit on a current copy arrives once
(`collab-publish.e2e-spec.ts` pins this). A page opened fully offline shows
this device's copy, read-only until the server answers.

### The editor

- `use-collab.ts` is imported dynamically by `EditorPage`, only when
  `GET /v1/collab/capabilities` says `enabled`. The server render and a
  deployment with the flag off never load Yjs. It creates the Y.Doc, the
  provider, the IndexedDB copy and a reactive `status`, and turns provider
  events into states (`followProvider`).
- `RichEditor.vue` takes an optional `collab` prop: StarterKit's undo/redo off,
  Collaboration and CollaborationCaret on. **In collab mode nothing ever calls
  `setContent`**: the Y.Doc is the only writer of the body. A local seed before
  the first sync is the classic Yjs double-page bug, and the spike reproduced
  it through the working-copy restore.
- The per-browser working copy is off from the first render. A copy saved
  before the page went live is offered once, and applied to the draft only on
  a click.
- Page fields bind to `meta` (`bindPageFields`). A text field follows whatever
  `Y.Text` its key holds now, because two tabs seeding one key at once leave
  one text and the loser has to switch to it (the Playwright test found this).
- If the draft cannot be joined within 10 s, the editor falls back to
  single-user editing.
- `CollabPresence.vue`, `CollabStatus.vue` and `CollabDraftBadge.vue` (document
  page and merge request sidebar) render from `status` and `GET :id/drafts`.

### Events

`draft.changed` (someone joined or left a draft, or it was checkpointed) and
`draft.reset` travel on `knowledge:events`. They are deliberately not
`document.*`: everything keyed on `document.*` would fire on every editor join.
`api/live-cache.ts` refreshes the drafts query on both. Neither raises a toast.

### MCP agents in a draft

An agent connected over MCP takes part in a draft the way the editor's
assistant does (#316). Two tools exist, on the API's HTTP MCP server
(`POST /v1/mcp`) only and only while `COLLAB_ENABLED` is on:

- **`knowledge_get_draft`** (view on the page) returns the draft body **as a
  publish would write it**. Pending suggestions are put back to what they
  replaced (`withoutSuggestions`), in the editor's own markdown spelling, so
  an anchor quoted from it is one the editor finds. It also returns the page
  fields, base and head (`headMoved`), `unpublished`, `editing`, and the
  waiting suggestions. A branch with no draft answers `draft: null`, and
  nothing is created: a read never opens a connection. It reads the doc this
  instance has loaded, or else the stored row.
- **`knowledge_suggest_draft_edit`** (edit on the page, a `WRITE_TOOLS`
  entry) takes the `edit_draft` shape, `{ op, anchor?, markdown }`, and
  writes a **ready** suggestion. The suggested blocks go into the body, and an
  entry goes into `suggestions` with `agent: { key: 'mcp', name: <key name> }`
  and `requestedBy` the key's person. Every open editor shows it at once with
  Keep and Discard. It is refused, and nothing is written, for the reasons
  `refuseDraftEdit` refuses the assistant (checked against the text
  `knowledge_get_draft` returns), and when the edit reaches inside a
  suggestion still waiting for a decision. A branch with no draft gets one,
  seeded from its head.

The write goes through `CollabGateway.writeDraft`: `settled()` first, so a
write never lands in a doc on its way out after a reset; then Hocuspocus's
`openDirectConnection`, one `transact`, and `disconnect`. The disconnect
stores at once, and Redis relays the update to peers on other instances. The
connection carries no principal, so the store credits nobody. A suggestion is
the requester's word, not their edit: whoever keeps it writes it in, and is
credited then.

`CollabDraftToolsService` lives in `collab/` beside the gateway.
`McpController` hands it to `McpService.buildServer` as an argument, so
`McpCoreModule`, which the stdio server shares, never imports collab. The
stdio server has no gateway and never lists the tools. The shared pieces are
in `@knowledge/editor-schema`, one implementation each for web and API:
`./serialize` (the markdown serializer), `./suggestions` (anchor resolution,
block indices, entry shapes, `withoutSuggestions`) and `./suggestion-entries`
(the Y.Map codec).

## Routes

```
GET    /v1/collab/capabilities           { enabled, schemaVersion } — authenticated only
GET    /v1/documents/:id/drafts          viewer · each branch's draft: base, unpublished, contributors, activePeers
DELETE /v1/documents/:id/drafts/:branchId editor · discard: reseed from the head, peers rejoin (reset)
POST   /v1/documents/:id/revisions       editor · now takes optional collabDraftId + draftSnapshot
WS     /v1/collab                         Hocuspocus; token = collabToken(kt_ ticket, generation)
MCP    knowledge_get_draft                viewer · HTTP MCP only, COLLAB_ENABLED
MCP    knowledge_suggest_draft_edit       editor · HTTP MCP only, COLLAB_ENABLED
```

Revisions in API responses carry `coAuthorIds`, an empty list unless they came
from a shared draft.

## Configuration

All have defaults; none is required.

| Variable | Default | |
| --- | --- | --- |
| `COLLAB_ENABLED` | `false` | Off: no Hocuspocus instance, no Redis connection, the socket closes 4503, `GET :id/drafts` is empty |
| `COLLAB_STORE_DEBOUNCE_MS` | `2000` | Quiet time before a store |
| `COLLAB_STORE_MAX_DEBOUNCE_MS` | `10000` | Longest wait under continuous typing; the most a crash can lose |
| `COLLAB_MAX_DOC_BYTES` | `8388608` | Encoded state cap (8 MiB) |
| `COLLAB_REAUTH_INTERVAL_SECONDS` | `300` | Re-check of every open connection |
| `COLLAB_CHECKPOINT_INTERVAL_MINUTES` | `15` | |
| `COLLAB_CHECKPOINT_KEEP` | `20` | Versions of the checkpoint key per draft |
| `COLLAB_DRAFT_RETENTION_DAYS` | `30` | Only drafts with nothing unpublished |

The web derives the socket URL the way `api/live.ts` does. It needs no
variable of its own.

## Observability

Every store emits one `collab.store` measurement event to the ops JSONL stream
(`OPS_JSONL_ENABLED`, `@knowledge/observability`). It records the store's
duration (encode, snapshot and PG write), the draft's encoded size, the
connections the draft has on this instance, and the outcome: `stored`,
`stale` (refused after a reset) or `too-large`. `make backtest ARGS=--report`
summarizes them: store latency percentiles, draft size, the most peers on one
draft, and the refusals.

## Load

`make collab-load` (`apps/api/test/collab-load.ts`) creates pages, joins
`--peers` providers per page across the given API instances, has one typist
per page append 34 characters every 20 ms while every peer moves its cursor
every 200 ms, and reports edit latency to the other peers, convergence and
draft size. It needs `AUTH_MODE=none` and archives its pages afterwards.

Measured on 2026-10-19 on the laptop: two API instances built from this
branch, one local Redis and Postgres, and the load generator on the same
machine. 5 peers per page, typists spread over both instances.

| | 10 pages × 5 peers, 30 s | 50 pages × 5 peers, 60 s |
| --- | --- | --- |
| Typing per page | 1.5 KB/s | 1.6 KB/s |
| Edit latency to other peers | p50 **3 ms**, p95 **8 ms**, max 33 ms | p50 **10 ms**, p95 **57 ms**, max 173 ms |
| Converged | 10/10 | 50/50 |
| CPU per instance (one core) | 16–29 % | 50–73 % ramping to about 100 % |
| RSS per instance | 375–490 MB | 340 → 520 / 355 → 650 MB |
| Stores | — | 300 in 52 s (**5.8/s**, one per page per 10 s), 545 KB/s written |
| Store duration | — | p50 52 ms, p95 210 ms (CPU-bound) |
| Draft size after the run | 79 KB | 163 KB |

At 50 busy pages both instances were CPU-bound, and the edit p95 stayed far
under the 500 ms target. The cost is the full-state store: each store
re-encodes the whole Y.Doc and computes its snapshot, and at 163 KB that is
most of the CPU. A busy page costs one store per `COLLAB_STORE_MAX_DEBOUNCE_MS`
however many people type in it. The worst case is still an 8 MiB draft
rewritten every 10 s while someone types, about 0.8 MB/s for one page. The
50-page run is far past the expected load: production runs one instance and
sees a handful of concurrent editors.

## Rollout

`COLLAB_ENABLED` defaults to `false`, so a self-hosted install opts in. The
hosted deployment turns it on in its `production` environment, which
`.env.production.example` requires. The dogfood pass below ran on 2026-10-19
on the dev stack, with two people (an admin and an editor in separate browser
contexts) under `AUTH_MODE=api-key`:

- [x] Two people (or two browsers) on one page: typing, the title and tags,
  carets with names, faces in the header.
- [x] One asks the assistant; the other sees the credit, "writing for …", and
  can keep or discard.
- [x] Publish from one; the other's chip clears; later edits stay unpublished;
  the revision shows both as co-authors.
- [x] Publish the same page through MCP; the editor shows the head-moved
  notice; Publish on top and Discard both work.
- [x] Take one browser offline, edit, reconnect: the edit arrives once.
- [x] Take one browser offline, discard the draft from the other, reconnect:
  the offline tab reopens the reset page, and the old text does not come back.
- [x] A viewer joins read-only; demoting an editor turns their tab read-only
  within `COLLAB_REAUTH_INTERVAL_SECONDS`.
- [x] A merge request whose source branch has a draft shows the warning.

Every item behaved as specified. The pass found four problems, fixed in #313:

- Discarding a draft stored the published page as a working copy, which
  `?branch=` then offered back for everyone. The working copy now waits for the
  page to load, and a non-default branch has a slot of its own.
- With the assistant open, a peer's face covered the "Unpublished changes"
  chip. The chips fold by the editor column's width now, not the window's.
- The status said "Live" for 30 s after the browser went offline. The
  browser's `offline` and `online` events now close and reopen the socket.
- The draft's review dialog was titled "Unstaged changes".

It also found a failed page load that opens an empty, publishable editor
(#314). That predates co-editing.

## Departures from the plan in #80

- **Tickets.** `kt_` URL tickets (#102) instead of a collab ticket service
  and `POST :id/collab/ticket`. Binding a ticket to a page added nothing,
  because admission re-checks the page anyway.
- **Page permissions**, not workspace roles: the issue predates feature 48.
  Revocation listens to `acl.changed` plus the interval; there is no role-change
  event to listen to.
- **Reasons, not close codes** (4401/4403/4409/4413): Hocuspocus closes a
  document, not the socket, and the provider sees only the reason.
- **Events** are `draft.changed` / `draft.reset`, not `document.draft.changed`.
- **`draftSnapshot`, not `stateVector`**: a state vector misses deletions.
- **One checkpoint key per draft**, with versions in the versioned bucket,
  rather than one key per timestamp.
- **`If-Match` is not required to equal the draft base.** It is the client's
  statement of what it builds on, and Publish on top must be able to say so.
- **Suggestions in a side map**, not schema marks: `SCHEMA_VERSION` did not
  change, and an old tab cannot corrupt them. No awareness `agent` field:
  "writing for …" is derived from the shared list and awareness liveness.
- **No `kn-ai-stream` origin**: `addToHistory: false` already keeps streamed
  suggestions out of y-tiptap's undo.
- **Schema mismatch** is checked by the client against
  `GET /v1/collab/capabilities`, not by a `sys` map in the doc.
- **Device copies carry a generation** (phase 6) rather than comparing
  `resetAt` in the doc, so nothing is written into the draft to detect a reset.
- **Not built:** `COLLAB_MAX_PEERS_PER_DOC`, a per-connection message rate
  limit and `COLLAB_IDLE_UNLOAD_SECONDS` (Hocuspocus unloads a doc once its
  last peer leaves and the store finishes). The ticket TTL is
  `AUTH_URL_TICKET_TTL_SEC`.

## Limits

- **A block move loses a concurrent edit inside the block.** Yjs has no move;
  the drag handle moves a block as delete + insert, so an edit inside the block
  from a peer who was offline during the move is gone. Accepted for v1. A fix
  needs a Yjs move or a "being edited" lock on the drag handle.
- **Publish on top overwrites** whatever the other path published. The review
  diff is the only safeguard until content merge exists.
- **An MCP read can trail a peer on another instance.** `knowledge_get_draft`
  reads the doc only when this instance has it loaded, and otherwise the
  stored row, which can be up to `COLLAB_STORE_MAX_DEBOUNCE_MS` behind. Its
  `editing` is `activePeers`, with the limit below. Exact with one instance.
- **`activePeers` is per instance.** It counts awareness on the instance that
  answers, including peers relayed from instances that have the doc loaded. It
  is exact with one instance (production); a scaled-out deployment needs a
  Redis presence key.
- **Presence lists your own other tabs**, under your name.
- **A device copy with no remembered generation is not checked.** That is a
  copy saved before this release, or one whose tab closed between the first
  sync and the server's join message (a few milliseconds). Such a copy across
  a reset would still merge.
- **Read-only writes are dropped but not counted.** Hocuspocus answers them
  with a sync status the client sees, and exposes no hook. The editor never
  sends them, because a read-only tab cannot type.
- **Suggestion entries whose range no longer resolves** (both ends deleted by
  peers) are skipped on read but never removed from the map. They are a few
  bytes each.
- **Stores write the full state**, not increments (see [Load](#load)).
  Tombstones grow the state between resets; nothing re-encodes it after a
  publish yet.
- **A schema change** (a new node or attribute in `@knowledge/editor-schema`)
  turns every open tab on the old build read-only until it reloads.
- **Comment anchors** are quote-based, so heavy concurrent editing can orphan
  them sooner. Feature 15's "outdated" path handles them; this is not measured
  at volume.

## Phase 0: the spike's decision record

The spike (throwaway branch
[`spike/80-collab`](https://github.com/hrustalq/knowledge/tree/spike/80-collab),
never merged) answered the issue's open questions on the laptop with two API
instances against one Redis. Verdict **GO**: Hocuspocus embedded in the API,
with the server seeding new drafts (option A).

| Question | Answer | Evidence |
| --- | --- | --- |
| `@hocuspocus/server` behind a Nest gateway? | Yes, as a library | Second gateway on the same `WsAdapter` and port, both serving |
| Peers on different instances converge? | Yes, via the Redis extension | 200 edits across instances: p50 1.0 ms, p95 2.4 ms |
| Latency in a real browser | Well under 500 ms | Playwright, two contexts: 48–75 ms, typing included |
| Seeded exactly once? | Yes, with a guarded insert | 5 clients across both instances at once: one seed |
| Read-only enforced server-side? | Yes | A read-only insert never reached a writer peer |
| Headless schema? | Yes, only `.vue` node views stubbed | 31 node types and 8 marks under jsdom |
| Every custom node survives the Y.Doc? | Yes, byte for byte | 16 fixtures: `md → PM → Y → PM → md` equals `md → PM → md` |
| Attributes JSON-safe? | Yes | The whiteboard scene is one string attribute: last writer wins |
| Server seed cost | Small | 3.4 ms for 1.3 KB of markdown, 31 ms for 25 KB |

Decided before the spike (comment on #80, 2026-10-18): server seeding,
Playwright for a two-context test (CI job `coedit-e2e`), a merge-request
warning rather than a gate, and the env flag as the only switch, with no
per-workspace setting.

The spike also found three pre-existing gaps in the markdown pipeline,
unrelated to Y: `TextAlign` is dropped on serialize, `[[Page title]]`
round-trips escaped in edit mode, and `> [!warning]` normalizes to
`> [!WARNING]`.
