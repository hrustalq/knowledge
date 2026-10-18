# 56 — Real-time co-editing of drafts (decision record, draft)

Issue [#80](https://github.com/hrustalq/knowledge/issues/80). **Status: phase 0
(spike) done, verdict GO.** This document records what the spike measured and
which parts of the plan in #80 it changes. Phase 6 rewrites it into the usual
feature document once the feature ships.

The spike code sits on the throwaway branch
[`spike/80-collab`](https://github.com/hrustalq/knowledge/tree/spike/80-collab)
and is never merged. It holds a Hocuspocus gateway in `apps/api/src/collab/`,
Node probes in `apps/api/spike/`, the fixture spec
`apps/web/src/components/editor/spike-collab-roundtrip.spec.ts` (run with
`npx vitest run -c vitest.spike.config.ts`), Collaboration wired into
`RichEditor.vue` behind `?collab=<name>`, and a two-context Playwright test in
`apps/web/e2e/`. Every number below came from that branch on the laptop:
two API instances (`:3000`, `:3001`) against one local Redis, plus the web dev
server.

## Decisions settled before the spike

These are recorded on the issue (comment of 2026-10-18):

- One phase per PR into `dev`, with a handoff comment on #80 after each phase.
- Seeding: **option A, the server seeds** a new draft from the branch head.
- Browser end-to-end tests: **Playwright**, with a two-context co-editing test.
- A merge request whose source branch has unpublished draft changes gets a
  **warning only**, never a merge gate.
- The only switch is the **`COLLAB_ENABLED` env flag**. There is no
  per-workspace setting in v1.

## Verdict

**GO, with Hocuspocus embedded in the API and server-side seeding.** Every risk
the issue named either held up or turned out cheaper than feared. The changes
the spike forces on the plan are listed under [Plan changes](#plan-changes).

| Question | Answer | Evidence |
| --- | --- | --- |
| Does `@hocuspocus/server` work behind a Nest gateway? | Yes, as a library | Second `@WebSocketGateway({ path: '/v1/collab' })` beside `/v1/events/ws` on the same `WsAdapter` and port, with both serving at once and no adapter noise in the logs |
| Do peers on different instances converge? | Yes, via `@hocuspocus/extension-redis` | 200 edits from `:3000` to `:3001`: p50 **1.0 ms**, p95 **2.4 ms**, max 4.3 ms, and both copies equal |
| Latency in a real browser | p95 well under the 500 ms criterion | Playwright, two contexts: a typed marker shows in the other context after **48–75 ms**, typing time included (3 of 3 runs) |
| Is a draft seeded exactly once? | Yes, with a guarded insert | 5 clients across both instances at once: one seed. 10 fresh docs: 10 seeds, one copy each |
| Are read-only writes enforced server-side? | Yes | A `readOnly` connection's insert never reached a writer peer |
| Do the editor's extensions build a schema headless? | Yes, with only the `.vue` node views stubbed | The full schema builds under jsdom: 31 node types, 8 marks |
| Does every custom node survive the Y.Doc? | Yes, byte for byte | 16 fixtures: `md → PM → Y → wire → PM → md` equals today's `md → PM → md`, and `PM.eq` holds |
| Are all node attributes JSON-safe? | Yes | No object or function attribute on any node. The whiteboard scene is one string attribute, so it merges atomically, last writer wins |
| Concurrent edits | Merge into valid markdown | Two peers typing in one table cell and a third edit in a panel: both serialize identically, and the merged markdown re-parses to itself |
| Cost of a server-side seed | Small | **3.4 ms** for a typical page (1.3 KB of markdown), **31 ms** for a 25 KB page |
| Memory and CPU | Fine at the target load | See [Load](#load) |

## Findings that change the plan

### 1. Auth failure is per document, not a socket close code

Hocuspocus multiplexes documents over one socket. When `onAuthenticate`
throws, the client gets a `permission-denied` message carrying
`error.reason`, and the socket stays open for its other documents. A denied
peer in the spike received `reason: 'forbidden'` and never synced.

So the close codes in §8 of the issue (4401 and 4403 per document) become
**reasons** (`unauthorized`, `forbidden`, `disabled`, `schema-mismatch`). The
`COLLAB_CLOSE_CODES` contract becomes `COLLAB_DENY_REASONS`. A real socket
close is left for the cases Hocuspocus closes itself (an unparsable frame
closes with 4401, its own `Unauthorized`).

Reset and too-large still work per document. `hocuspocus.closeConnections(name)`
closes every connection to one draft. An error thrown from
`beforeHandleMessage` closes that document's connection with the error's `code`
and `reason`. **Verified in phase 2: it does not.** A per-document close is
a close *message* that carries only the reason, and the provider reports it as
`{ code: 1000, reason }` (`collab-auth.e2e-spec.ts` pins this). So every
per-document outcome is a reason in `COLLAB_DENY_REASONS` (`too-large`,
`access-changed`, and later the reset), and the only close code left is 4503
on the socket when the flag is off. After a close message the provider does
not rejoin by itself: the client decides, from the reason, whether to rejoin
with a fresh ticket.

### 2. Tickets already exist: reuse `kt_`

`apps/api/src/auth/url-tickets.service.ts` (#102) already issues short-lived,
single-use URL tickets. They are minted by `POST /v1/auth/url-ticket`, stored
as a SHA-256 in Redis, redeemed with `GETDEL`, and expire after
`AUTH_URL_TICKET_TTL_SEC` (60 s). This is the ticket §7 of the issue
re-specifies. The provider's `token` option accepts an async function, so it
mints a fresh `kt_` for every (re)connect.

So **drop** `collab-ticket.service.ts` and `POST /v1/documents/:id/collab/ticket`.
Binding a ticket to one document and branch adds nothing: `onAuthenticate`
re-checks access for the requested document anyway. The flag and the schema
version the ticket response was going to carry move to
`GET /v1/collab/capabilities` (`{ enabled, schemaVersion, url }`), following
the `GET /v1/exports/capabilities` precedent.

### 3. Access is page permissions, not a workspace role

The issue predates page permissions (#76, feature 48). A workspace `viewer`
role is no longer enough to open a page. `onAuthenticate` must ask the same
predicate as every REST route with `@Access(…, 'document')`:
`PermissionService.requireResource(principal, workspaceId, { type: 'document', id }, role)`,
with `viewer` to connect and `editor` to write. A refused page must not leak
its title in the deny reason (feature 48's rule).

Revocation: `KNOWN_EVENT_TYPES` has **no** membership or role-change event, so
§8's "listen for role changes" has nothing to listen to. The bus does carry
`acl.changed` (`permissions/acl-events.service.ts`, per workspace). So: re-check
the open connections of a workspace on `acl.changed`, and re-check all of them
every `COLLAB_REAUTH_INTERVAL_SECONDS`. That interval is the only path for a
plain role change.

### 4. Seeding A is a four-file split, not a rewrite

The issue estimated extracting a DOM-free schema as possibly L on its own. The
spike loaded the editor's **real** extensions under jsdom, with only the `.vue`
imports aliased to a stub, and built the complete schema. A node view only runs
when an `EditorView` exists, so the specs are already DOM-free.

`packages/editor-schema` therefore means:

- Splitting the four extension files that import SFCs (`blocks.ts`, `api.ts`,
  `inline.ts`, `media.ts`). The spec goes to the package, and the web keeps
  `Spec.extend({ addNodeView: () => VueNodeViewRenderer(X) })`.
- Moving `lib/markdown/render.ts` and `nodes.ts` into the package.
  `render.ts` uses relative `./nodes.js` imports today, which the **buildless
  package constraints** forbid, so those become self-references.
- `ApiContract` and `CommentAnchors` take a `t` option. The server seed passes
  a translator for its locale.

Use **jsdom** for `generateJSON` on the server. It is what the spike measured,
and it is already in the lockfile (a `apps/web` dependency). happy-dom is not
needed.

The guarded insert is what prevents the classic double seed across instances.
`onLoadDocument` runs independently on every instance that has a peer. The
spike stood in for `INSERT … ON CONFLICT DO NOTHING` + re-read with Redis
`SET NX` + re-read, and the loser adopted the winner's state. Phase 1 does
the same in PG.

### 5. The editor must never `setContent` in collab mode

This is the most important editor finding. With Collaboration on, tab B's
**working-copy restore** (`useWorkingCopy`, localStorage) called `setContent`
before the provider's first sync. Y then merged that local seed with the
server's state, and the page body appeared **twice** for everyone. It is the
classic Y seeding bug, reproduced in the real app through a path the issue did
not list.

In collab mode, therefore:

- **No** `content:` and **no** `setContent` at all: neither the `modelValue`
  watcher in `RichEditor.vue` (L779–793 today), nor the `resolvePage` re-parse,
  nor a restore. The Y.Doc is the only writer of the body.
- `useWorkingCopy` is off from the first render, not after the first sync.
  §10's "offer the old localStorage copy" import must apply as an ordinary
  edit *after* `synced`, and only on a click.

### 6. AI suggestions: confirmed broken as predicted, and one plan item is redundant

`applyAiEdit` in tab A inserted its preview, and the text replicated to tab B
as **plain content**. B showed no violet gutter and no Keep/Discard bar,
because the suggestion list lives in A's plugin state. Phase 5's redesign
(suggestion state in the Y.Doc, attributed) is needed as planned.

But y-tiptap already honours `addToHistory: false`: its `UndoManager` uses
`captureTransaction: tr => tr.getMeta('addToHistory') !== false`. In the spike,
A's undo skipped the streamed suggestion. §6's dedicated `kn-ai-stream`
transaction origin is therefore **unnecessary**. Keep the existing meta.

### 7. A block move loses a concurrent edit inside the block

Yjs has no move operation. The drag handle moves a block as delete + insert.
In the spike, B edited inside an expand while offline, A dragged that expand to
the end, B reconnected, and **B's edit was gone** (the moved copy is new
content). This is the issue's risk of "a node view that replaces the node",
caused by the drag handle rather than a node view.

v1 accepts this and documents it. Moves are rare and quick, and the realistic
case (two people in one block during a drag) is narrow. A fix needs either a
Yjs move (not in 13.x) or a "block is being edited by …" lock on the drag
handle. Revisit after dogfooding.

### 8. Smaller ones

- **Undo is per peer.** A's undo removed only A's text, and B's later edit
  survived. This is the desired behaviour, verified.
- **Node-view attribute edits sync.** Changing the API block's method in B
  appeared in A.
- **Carets need CSS.** `CollaborationCaret` draws the label and selection but
  ships no styles. Unstyled, the label renders as a full-width bar. Phase 3
  styles it from `avatarColor(userId)`.
- **The Redis extension brings its own `ioredis` (~5.6)**, separate from the
  API's ^6. No conflict, and its traffic stays off `knowledge:events`, as §1
  wanted.
- **Stores happen only on the instance where an edit originated.** Updates
  arriving over Redis skip the store hooks, so two instances do not double
  every PG write.

### Pre-existing gaps found on the way (not collab)

The fixture corpus exposed three places where today's markdown pipeline
already normalizes or loses something, with or without Y:

- **`TextAlign` is dropped on serialize.** A centered paragraph publishes as a
  plain one, so alignment set in the editor never survives a publish.
- In edit mode, `[[Page title]]` (with no resolver) round-trips as
  `\[\[Page title\]\]`.
- `> [!warning]` normalizes to `> [!WARNING]` (harmless).

The first is a real bug and worth its own issue. It is outside #80's scope.

## Load

50 documents × 5 peers = 250 sockets, split across both instances. One typist
per document at about **1.5 KB/s** (34 chars every 20 ms) and an awareness
update from every peer every 200 ms, for 60 s. All peers converged.

| | `:3000` (typists' instance) | `:3001` |
| --- | --- | --- |
| CPU (one core), sampled every 8 s | 38–62 %, about 45 % on average | 23–35 % |
| RSS, idle → under load | 269 → 305 MB (the whole API) | 228 → 249 MB |
| Store writes | **1 per active doc per `COLLAB_STORE_MAX_DEBOUNCE_MS` (10 s)** under continuous typing, about 5/s at 50 docs | 0 |
| Bytes written | about 40 KB per write on average, growing with the document | — |

The writes are **full state**, not increments: each store re-encodes the whole
Y.Doc. That is fine at this scale. The worst case is an 8 MiB document
(`COLLAB_MAX_DOC_BYTES`) rewritten every 10 s while someone types, about
0.8 MB/s for one document, and phase 6's load test should watch for it.
Encoded Y state was 2.6× the markdown at seed (1,257 B of markdown, 3,247 B of
state). Tombstones grow it from there, which is why the re-encode after publish
listed in the risks stays.

## Playwright

`@playwright/test` 1.64 ran the two-context test against the dev stack using
`channel: 'chrome'`. The installed Chrome means no browser download. GitHub's
Ubuntu runner images ship Chrome too. The cost lands in CI: `ci.yml` runs no
services today, so the co-editing test needs **its own job** that starts the
compose infra, builds, and runs the API and the web before
`playwright test`. It belongs in phase 3, next to the first test it runs.

## Plan changes

Applied to #80's phases, by phase:

| Phase | Change |
| --- | --- |
| 1 | Seeding A uses jsdom. Guarded insert as above. Otherwise unchanged. |
| 1 | Add the `packages/editor-schema` split (four extension files + `render.ts`/`nodes.ts`) here rather than treating it as an L add-on to phase 3. The server seed needs it in phase 1. |
| 2 | Drop `collab-ticket.service.ts` and `POST :id/collab/ticket`. Reuse `kt_` tickets. Add `GET /v1/collab/capabilities`. |
| 2 | Authorize with `PermissionService.requireResource` (page permissions), not `AccessService.requireRole`. Re-check on `acl.changed` plus the interval. |
| 2 | Per-document deny **reasons** replace the 4401/4403 close codes. Verify that custom close codes 4409 and 4413 reach the provider. |
| 3 | Collab mode never calls `setContent`, and `useWorkingCopy` is off from the first render. Caret styles. Add the Playwright CI job and the first two-context test. |
| 5 | Drop the custom `kn-ai-stream` origin, because `addToHistory: false` already keeps streamed suggestions out of undo. |
| 6 | Document the block-move limitation (finding 7). The load test watches full-state write volume. |

## Open questions answered

From the issue's *Risks & open questions*:

- **Transport:** works cleanly, and Redlock's `ioredis` is separate (finding 8).
- **Schema drift:** unchanged. The `schemaVersion` gate (read-only on mismatch)
  stays.
- **Server-side schema:** cheaper than feared (finding 4).
- **Undo semantics:** per-peer undo verified. Keep-as-author-edit is still to
  verify in phase 5.
- **Custom node views:** attribute last-writer-wins is fine. The drag handle's
  move is the real loss case (finding 7).
- **Comment anchors** under heavy concurrent edits: not measured. The
  extension loaded and decorated without errors, and volume is phase 6.
- **MR gate:** warn only (decided).
- **Storage growth:** full-state writes measured (see [Load](#load)).
  Re-encode after publish stays in the plan.
- **Browser e2e:** Playwright (decided), feasible as shown.
- **Per-workspace setting:** none in v1 (decided).
