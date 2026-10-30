# 71 — A project is a git remote (decision record, draft)

Issue [#636](https://github.com/hrustalq/knowledge/issues/636). **Status: phase 0
(spike) done, verdict GO.** This document records what the spike measured, the
model it settled on, and which parts of the plan in #636 it changes. Phase 6
rewrites it into the usual feature document once the feature ships.

The spike code sits on the throwaway branch
[`spike/636-git`](https://github.com/hrustalq/knowledge/tree/spike/636-git)
under `apps/api/spike/git/` and is never merged. It is plain Node plus the
`git` binary and imports nothing from the app: a git object serializer, a model
of the stored commits proposed below with a per-reader renderer, a smart-HTTP
server (real `git upload-pack` for fetch, our own receive-pack for push), a
42-claim driver script that runs real `git` against it, and a 3-way merge fuzz.
Every number below came from that branch on the laptop (Apple git 2.50.1 as the
client, Node 26), except the image measurement, which ran
`node:24.21.0-bookworm-slim`, the base of `Dockerfile.api`.

## Decisions settled before the spike

Recorded on the issue (comment of 2026-10-30):

- One phase per PR into `dev`, with a handoff comment on #636 after each phase.
- **Commits are stored, not synthesized on read.**
- **The real `git` binary serves fetches; receive-pack is ours.**
- **The backfill groups legacy per-page branches by (project, name)**, splitting
  with a `-<shortid>` suffix only where grouping would give one branch two open
  merge requests into the same target. Personal `draft/` branches fold per person.
- Phase 0 is a doc-only PR plus probes on a throwaway branch.

## Verdict

**GO.** Every claim the issue's end state rests on held up against real `git`,
and the two house rules it collides with have a clean answer. The spike adds
three invariants the later phases must keep ([below](#invariants)) and changes
the plan in the places listed under [Plan changes](#plan-changes).

| Question | Answer | Evidence |
| --- | --- | --- |
| Are SHAs deterministic for one visible set? | Yes | Two renders of the same model, and two renders with the visible set in reverse order, give the same head SHA; two clones by one person give identical SHAs over HTTP |
| Do different visible sets get different SHAs, without leaking? | Yes | Bob (a restricted subtree hidden) gets a different head, fewer files, and zero commits touching the hidden page: `git log --all -- page-2.md` is empty in his clone |
| Does git accept what we write? | Yes | `git fsck --strict --no-dangling` is clean on every cache and on a fresh clone after all the pushes, and `git rev-parse` agrees with the SHAs computed in Node |
| Does history mirror the DAG, merges included? | Yes | 389 two-parent merge commits in a 6,667-commit synthetic project; `git log --graph` draws them with order 1 = target |
| Clone and fetch over smart HTTP, v2 and v0? | Yes | `git clone` (protocol v2), `git -c protocol.version=0 clone` (same SHA), `--depth 1` (shallow) |
| Does a pushed commit keep its SHA? | Yes, byte for byte | After every accepted push `git ls-remote` returns the local `HEAD`, the next fetch is a fast-forward, and a fresh clone has the same commits. This includes moves, new pages, removals, CRLF bodies, an empty commit and a commit carrying a (fake) `gpgsig` header |
| Push options and the MR URL? | Yes | `-o merge_request.create -o merge_request.title=…` prints `remote: View merge request !1` and its URL. The MR lists both pages, and a second push prints `Updated merge request !1` |
| Refusals with a `remote:` reason? | Yes | Read key, force push (`remote: Revisions are immutable…`), protected `main` (names the gate and `-o merge_request.create`), unapproved merge-by-push (`approvals`), directory without a parent page, executable bit, changed `knowledge-id`, binary file, non-page file |
| Stale push? | Refused, by git itself | The client refuses `(fetch first)` before sending when it lacks the remote head; the server's own `old ≠ current` check is the race guard behind it |
| Merge by pushing a local merge commit? | Yes | Unapproved → `remote: Merge request !1 needs 1 approval`; approved → `remote: Merged merge request !1`, and `origin/main^2` is the MR's source head |
| en/ru `remote:` messages? | Yes, with a fallback | See [finding 4](#4-git-does-not-always-send-accept-language) |
| Can a 3-way merge in-process agree with git? | Yes | `node-diff3` with `excludeFalseConflicts` matches `git merge-file` on 6 named cases and on **3,000 of 3,000** fuzzed edits, in both the clean/conflict verdict and the merged bytes |
| Cost | Fine at realistic sizes | See [Numbers](#numbers) |

## The model

### Stored commits

A **commit** is a row per state-changing transaction in a project: a finalize,
a merge, a push, a move, a rename, an archive or unarchive, a publish. It
holds:

- its parents, ordered (order 1 = first parent, as `revision_parents`);
- the branch it was written on;
- **header bytes** (`bytea`): everything a git commit carries after its `tree`
  and `parent` lines — `author`, `committer`, `encoding`, `gpgsig`, the message
  — frozen at write time. For a web, REST or MCP write the server composes it
  (below). For a push it is the pushed object's bytes, verbatim.
- **change rows**, one per page it touched, each holding that page's full tree
  state *after* the commit, relative to the first parent: `document_id`,
  `revision_id`, `parent_document_id`, `slug`, `ext`, `archived`, and the id
  line's `form` (offset + text, below).

The commit SHA is never stored. It is a pure function of (commits, visible set),
computed by the renderer and cached on disk per visible set.

The spike settled this against the alternative, synthesizing commits from
revisions on read, because the tree is not versioned today: `documents.path`,
`title`, `archived_at` and `draft_owner_id` hold only their current value. A
commit built on read can only place a page where it sits *now*, so every move
or rename would rewrite every reader's history (each fetch a forced update), and
a move or an archive could never be a commit of its own.

Header bytes are bytes, not text. The first probe stored the header as a
string and `fsck` rejected the commits (`badName`): a Cyrillic author name
had been encoded twice. Freezing them at write time also means a person
renaming themselves does not rewrite history.

Server-composed headers look like this, with `+0000` and the revision's
`finalized_at`:

```
author Анна Петрова <8c1e…-uuid@users.noreply.knowledge> 1793030400 +0000
committer Анна Петрова <8c1e…-uuid@users.noreply.knowledge> 1793030400 +0000

<revision message, or "Update <slug>">

Co-authored-by: Bob Stone <…-uuid@users.noreply.knowledge>
```

The email is `<userId>@users.noreply.<GIT_NOREPLY_DOMAIN>`, never an address. A
merge commit's message is GitLab's (`Merge branch 'x' into 'main'`, the MR
title, `See merge request !<n>`).

### One reader's view

`View` (`apps/api/spike/git/view.mjs`) renders the commits for one visible set:

- A commit with no visible change drops out. Its children reattach to the
  nearest kept first-parent ancestor. A second parent that collapses onto the
  first, or onto one of its ancestors, is dropped (`--simplify-merges`). An
  empty commit, one with no changes at all, is everyone's.
- A page whose parent page is out of view would sit at the root. For a member
  this cannot happen: the visible set is closed upward, because `restricted_by`
  names every restricted ancestor and a member sees every unrestricted node.
  For a **guest** it can, and the path would name pages the guest cannot open,
  so **guests are refused** (403) in v1.
- Rendering is incremental. History is append-only, so a commit's SHA in a view
  never changes once computed. Directory nodes are copy-on-write, so a new
  commit costs only the directories on its changed paths, and page state is a
  delta chain along first parents, flattened every 32 links.

The visible set is computed per request from the caller's `AccessScope`
(`visibilitySql`, feature 48), and its sorted id list's hash is the cache key.
Two people with equal access share one cache and one set of SHAs.

**SHAs per view are stable until the view changes.** A grant, a restriction, a
group change or a hard-deleted page changes what someone sees, and that
person's history is rewritten: their next fetch is a forced update, and local
branches cut from the old history must be rebased. The feature document must
say so in plain words. It is the price of the issue's "each person sees their
own view", and nothing cheaper keeps a hidden page out of a hidden commit.

### Concurrent edits nobody can see

A push names its parent as a SHA in the pusher's view. If someone changed only
pages the pusher cannot see after the pusher fetched, that commit is dropped
from the pusher's view, so their head SHA has not moved. The push stays
fast-forward, and the server stores it on top of the real branch head, not the
pusher's apparent one. Because changes are stored relative to the first parent,
the hidden edit survives in everyone else's tree, and the pusher's commit still
renders to the SHA they pushed. Probed: bob's push after a hidden edit is
accepted with its SHA kept, and alice's clone shows both bob's commits and the
hidden page's new content.

### The tree mapping

| Page | Path |
| --- | --- |
| `kind: page` | `<parent dirs>/<slug>.md` |
| `kind: openapi` / `asyncapi` | `<slug>.yaml` or `<slug>.json`, by the revision's content type |
| children of a page | inside `<parent dirs>/<slug>/` |

**Identity is the id line.** A served file carries `knowledge-id: <uuid>` as its
first frontmatter key (a frontmatter block is added if the page has none); a YAML
spec carries `x-knowledge-id: <uuid>` as its first line, and a JSON spec carries
`"x-knowledge-id": "<uuid>"` as its first member. The stored revision never
contains it: `strip` removes it on push and records exactly what it removed and
where (`form`). Rendering puts back exactly that, so `render(strip(x)) === x`
for any pushed blob, however the person laid out their frontmatter. A
web-written revision gets the canonical form. (Markdown and the YAML form are
probed. The JSON form is designed only.)

On push, a file at an unchanged path is the page that path held in the parent
commit **in the pusher's view**. An added file whose id names a page deleted in
the same commit is a move. An added file without an id is a new page whose id
appears in no blob, which is exactly why its SHA survives. A deleted file with
no matching addition is an archive. A page the pusher cannot see is in neither
tree, so no push can touch it.

**Slug rules.** A slug is derived from the title when the server writes one:
NFC, lowercase, whitespace runs to `-`, `/ \ : * ? " < > |` and control
characters removed, runs of `-` collapsed, leading and trailing `-` and `.`
trimmed, cut at 80 UTF-8 bytes on a character boundary, `page` if nothing is
left. Cyrillic stays Cyrillic (`архитектура.md`). A Windows-reserved stem
(`con`, `nul`, `com1`…) gets `-page`. A pushed filename is kept verbatim, since
it has to reproduce. It is refused only for the forbidden characters, a reserved
stem, or a sibling that collides with it **case-folded**, because macOS and
Windows checkouts are case-insensitive. A collision found when the server writes
gets `-<first 8 hex of the id>` on the page that arrived second. The decision is
stored in `documents.slug` and on the change row, so it never flips later.
Renaming a page in the web renames its file: one change row, and the directory
moves with it.

### Invariants

Three rules the probes depended on. Each later phase keeps them:

1. **Reproduce or refuse.** Before a push is accepted, its commits are rendered
   in the pusher's view, and the SHA has to equal the pushed SHA. If it does
   not, the push is refused. This is what makes every shape safe that the
   mapping cannot express. One example: `git mv page.md new.md` without moving
   `page/` is refused, with `remote: A page's directory moves with its file`,
   because the model moves children with their page and the pushed tree did
   not. Moving both in one commit is accepted with its SHA kept. A pushed
   history that contains such a commit cannot be accepted in part: it has to be
   rewritten locally first.
2. **History is append-only.** No force push, no rewrite. The web's "Rebase"
   action from the issue therefore cannot rewrite the source branch (see
   [Plan changes](#phase-2--3-way-merge-and-update)).
3. **Merge bases stay per page on the revision DAG** (`findMergeBase` in
   `compare.service.ts`). The commit graph is a projection for git, never the
   source of a merge decision. For a branch created in the new shape the two
   agree. For a grouped legacy branch whose pages forked at different points,
   only the per-page base is right.

## Findings that change the plan

### 1. The per-branch content-hash unique blocks `git revert`

`@@unique([documentId, branchId, contentHash])` means a branch can never return
to content it once held. `finalizeRevision`'s dedupe makes it worse: a body
equal to any earlier revision on the branch deletes the new draft and returns
the old revision **without advancing the head**. A web user reverting a
paragraph meets the same thing today. A pusher's revert would be acknowledged
and then never served back, so reproduce-or-refuse would fail it.

**Phase 1 drops the unique for a plain index, and dedupes only against the
branch head** (a body equal to the head is a no-op that writes no commit).
Phase 1 also checks that nothing relies on the constraint as a concurrency
guard.

### 2. `LISTED_PAGE` does not hide archived pages

`common/listed-page.ts` filters `pending_merge_request_id IS NULL` only. The
issue assumed it covered archived pages too. In this model neither filter is
needed in the tree builder: a pending page has no commit on the default branch
until its merge, and an archive is a change row. Every *list* surface keeps
its own `archived_at IS NULL`, as now.

### 3. A private draft page cannot be in history before it is published

A private draft page (`draft_owner_id`, feature 66) has revisions on the
default branch that only its owner can see. If they were commits, publishing the
page would make them visible to everyone at once, rewriting every other reader's
history on every publish. **A draft page's revisions write no commit. Publish
writes one commit that adds the page at its head revision.** The owner does not
see the draft in their clone until it is published. A later phase could serve
drafts on a private ref (`refs/drafts/*`), but that is out of v1.

For the same reason, **a new file pushed straight to the default branch is
refused**, with a `remote:` line pointing at `-o merge_request.create`. Feature
66 would make it a private draft, which (above) cannot be in history. A new file
on a branch is head-less behind its merge request (`pending_merge_request_id`),
as a capture is today.

### 4. Git does not always send `Accept-Language`

Git sends `Accept-Language` from `LANGUAGE`, or from the locale only when it was
built with gettext. Apple's git is built `NO_GETTEXT`. The probe confirmed it:
`LANG=ru_RU.UTF-8 git push` sends no header, while `LANGUAGE=ru git push` sends
`ru, *;q=0.9`. **The remote's locale is `Accept-Language` when sent, else the key
owner's `users.locale`** (feature 18). That second rule is what makes the ru
messages work for most people.

### 5. `git` from apt adds 96 MB

On `node:24.21.0-bookworm-slim`, `apt-get install --no-install-recommends git`
installs git 2.39.5 and adds **98,488 KB**, mostly perl and git-man. Only the
git process needs it: the API's 3-way merge is `node-diff3`, in-process. **Phase
3 adds a `git-runtime` stage on top of `runtime` in `Dockerfile.api`**, used
only by the git service. The API and worker images stay as they are, and the
layers are shared. Copying just the `git` binary (upload-pack, pack-objects,
index-pack, rev-list, cat-file, diff-tree and merge-base are all builtins) would
be smaller. That is worth one measurement in phase 3, not a design decision.

### 6. `MergeRequestsService` lives behind controllers

It is provided by `DocumentsModule`, which carries controllers. The git process
needs it to open, update and merge merge requests, and per
[01](../architecture/01-entrypoints-modules.md) a controller-bearing module must
not load there. **Phase 1 extracts a controller-free `MergeRequestsCoreModule`**,
re-exported from `DocumentsModule` so no call site changes. This is the
`DocumentsCoreModule` precedent.

### 7. Pushed author lines are the pusher's

A pushed commit's header is kept verbatim, so `git log` shows the name and email
in the pusher's git config: a real address, or someone else's name. Attribution
in PostgreSQL (`author_id`, the activity feed, MR authorship) is always the
authenticated principal. That never changes. **Recommended for phase 4:** refuse
a push whose author or committer email is not the pusher's noreply address. The
`remote:` message gives the exact `git config user.email …` line, and the Clone
dialog (phase 5) shows it up front. This keeps the issue's "never a person's real
address" true for pushed history too, and stops one person writing commits under
another's name. It costs every new user one config line, so it is flagged for a
decision at phase 4.

## The protocol

**Fetch is the real `git upload-pack --stateless-rpc`** over a bare cache per
(project, visible set). The cache is filled by writing a pack of the objects it
lacks (whole objects, a few lines of Node) and handing it to `git index-pack
--stdin`. Refs are a `packed-refs` file. `--advertise-refs` answers
`info/refs`; for v2 the `Git-Protocol` header becomes `GIT_PROTOCOL` and the
`# service=` preamble is omitted. Negotiation, shallow clones and pack
generation are git's own code. That is the reason for the binary: these are the
parts of the protocol with the most edge cases.

**Push is ours.** Receive-pack's framing is small: command pkt-lines with
capabilities, push options, the pack, then `report-status` (`ok` or
`ng <ref> <reason>`) in side-band 1 and messages in side-band 2, which the
client prints as `remote:`. The pack goes to `git index-pack --stdin --fix-thin`
in a quarantine directory, with the reader's cache as its alternate, and is
read with `git cat-file`, `rev-list` and `diff-tree -z --no-renames`. Owning
this side is what puts every decision (key scope, gates, mapping, locale, MR
messages, reproduce-or-refuse) in our code rather than in hook scripts. Pushes
are `atomic`: if any command fails, none applies.

**Rejected:** isomorphic-git has no upload-pack server, so it would be our own
protocol code behind a client library. A pure-TypeScript server means writing
v2 negotiation, shallow handling and pack generation. `git http-backend` would
put push decisions in pre-receive hooks talking back to Node, which makes every
refusal message harder to own.

### Authentication

HTTP Basic, the password a `kn_` API key resolved by `TokenAuthService`. No
`ks_` session tokens, since those are browser credentials. Any username is
ignored. A `read` key fetches only, and its push is refused in `remote:`
(probed), not at HTTP level, so the person sees why. A `write` key pushes if
`requireRole(…, 'editor')` passes. A `capture` key and a guest get 403. A
workspace-pinned key narrows as everywhere (`principal.apiKey`). The URL's
workspace segment must own the project, or the request 404s, which is the
cross-tenant guard. `AUTH_MODE=none` lets the dev principal through, as
elsewhere. Failed authentication is rate-limited like the public routes.

## How it meets the house rules

**"The API never streams file bodies."** Packs flow through a **sixth
entrypoint**, `apps/api/src/git.main.ts`, a separate HTTP process
(`NestFactory.create(GitModule, { bodyParser: false })`) behind `/git/*` in
`Caddyfile`. Its compose service is from the `git-runtime` image, with a volume
for the caches. The bytes it receives are written to MinIO under the ordinary
revision key and then finalized, as a merge does today. There is no second write
path, and the API process never sees a pack. A separate process also keeps a
cold cache build, a large pack or a `git` child from competing with API requests
on the one box production runs on.

**"The worker generates, the API publishes."** The git process authenticates a
principal and creates revisions and merge requests attributed to them, so it is
on the publishing side of that rule. It is never the worker's job. Phase 3 adds
it to the entrypoint table in
[01](../architecture/01-entrypoints-modules.md) and to dependency-cruiser:
`git.main.ts` composes `GitModule` and `*CoreModule`s only, never `AppModule`,
`WorkerModule` or a `*WorkerModule`, and `GitModule`'s controller loads nowhere
else.

**Doc 05's "refusing is legible".** [05](../architecture/05-merge-review.md)
refuses every diverged merge because a content merge that goes wrong reads as
if two people wrote alternate paragraphs. The 3-way merge keeps that promise for
the case it was about. **Only hunks that do not overlap merge. Overlapping or
adjacent hunks refuse** with `reason: 'conflict'`, naming the pages and hunks,
exactly where local git would. The probe shows `node-diff3` and `git merge-file`
agree on every case, so a person who resolves with `git pull` sees the conflicts
the server saw. The merge request shows the merged result before it lands, so
nothing merges unseen.

## Plan changes

### Phase 1 — split in two

It is too large for one reviewable PR.

- **1a, stored commits, no behaviour change.** `project_commits`,
  `project_commit_parents` and `project_commit_changes`, plus `documents.slug`.
  Every writer in the [list above](#stored-commits) writes one commit inside its
  own transaction. `finalizeRevision` takes an optional open commit so a merge
  or a push writes one commit for N revisions. The backfill writes one commit
  per finalized revision in `finalized_at` order per project, merge revisions as
  two-parent commits, and today's paths. Drop the content-hash unique
  ([finding 1](#1-the-per-branch-content-hash-unique-blocks-git-revert)) and
  extract `MergeRequestsCoreModule` ([finding 6](#6-mergerequestsservice-lives-behind-controllers)).
  Every new model goes into `workspace-teardown.inventory.ts`.
  **As built:** `ProjectCommitsService` (`apps/api/src/git/`). It takes a
  per-project advisory lock, first in every writing transaction (a merge takes
  it before its branch-row lock), and every writer goes through it. Where the
  build differs from the plan above:
  - A change row stores `removed` (archived, or moved to another project)
    instead of `archived`.
  - `ext` and the id-line `form` are not stored. `ext` follows from the
    revision's content type, and `form` arrives with pushes in phase 4.
  - `finalizeRevision` takes the merge's commit attribution, not an open commit.
    One commit per revision is all 1a needs, so 1b widens it to N pages.
  - `GIT_NOREPLY_DOMAIN` ships here rather than in phase 3, because headers are
    frozen as they are written.
  - A cross-project move writes a removal in the old project and an add in the
    new one.
  - `MergeRequestsCoreModule` is deferred to the phase whose git process first
    needs it. `MergeRequestsService` injects `AccessService`, so the extraction
    has to solve that, and nothing in 1a consumes it.
- **1b, project branches and multi-page merge requests.** `project_branches`
  (name, fixed base commit, head commit, owner, protected, restricted).
  `document_branches.project_branch_id` is nullable, backfilled, then `NOT
  NULL`. **The page set of an open MR is derived** from the pages its source
  branch changed, and a merged MR's set from its merge commit, so there is no
  `merge_request_documents` table. `merge_requests.document_id` becomes nullable
  for one release. The breaking-API ack and the lint check pin the source
  **head commit** instead of one revision, so any push makes them stale, exactly
  as now. The atomic merge stages the N bodies in MinIO **before** the
  transaction opens, then takes the branch-row locks in id order and
  finalizes inside. Today's four S3 round trips per page inside the
  transaction do not scale to N.
  **As built, split again.** 1b ships as two PRs. **1b-1** is project branches
  with no behaviour change. **1b-2** is multi-page merge requests, the
  atomic merge, the draft fold and the web Changes view. Where 1b-1 differs
  from the plan above:
  - `project_branches` holds only (workspace, project, name). `protected`,
    `restricted` and the owner stay on each page's `document_branches` row,
    so an empty settings table still merges as before; a gate reads "any page".
    There is no base or head commit column. A branch's base is its first
    commit's first parent, and its head is its latest commit, both already in
    `project_commits`. An unwritten branch follows the default head, as doc 66
    already says of drafts.
  - `document_branches.project_branch_id` stays **nullable** for one release,
    because the previous image inserts branches without it. A release after
    1b-1 ships sets `NOT NULL`, filling any gap the way
    `ProjectCommitsService.rehomeBranches` does.
  - The backfill splits more than planned. It splits any group that a merge
    request came from, not only one that would hold two open merge requests,
    because 1b-2 derives an open merge request's pages from its source
    branch. A legacy merge request must not gain pages it never had. The
    earliest page branch keeps the name, the others become
    `<name>-<page id 8 hex>`, and their 1a commits are renamed and
    re-parented with them. A default branch is never renamed.
  - Personal `draft/` branches are **not folded by the migration**. A new
    draft name is the first one free in the project (`draft/<id>`,
    `draft/<id>-2`, …), so every new draft starts its own project branch.
    The fold happens going forward, in 1b-2.
  - A page moved to another project, alone or by deleting its project, has
    its branches re-pointed at the destination's branches of the same names
    (`rehomeBranches`).
  **1b-2 is split again** (decided 2026-10-30): **1b-2a** is multi-page merge
  requests end to end (API, MCP, the web Changes view); **1b-2b** is the draft
  fold, "Publish N pages" and doc 66. Where 1b-2a differs from the plan above:
  - `merge_requests.document_id` stays `NOT NULL`. It is the page the merge
    request was opened from, so the `merge-request` ACL source, the activity
    feed, notifications and threads still resolve through it. The page set is
    derived beside it by `sourcePages` (`documents/mr-pages.ts`): every page
    branch of the source project branch with a finalized revision of its own,
    plus the opening page. A page whose source head the target already holds is
    left out. A merged merge request lists nothing left to merge, and its
    Changes tab shows its own page as before.
  - Merging needs edit on every page, checked in `merge` after the guard's
    check of the opening page. A page with no branch of the target's name is
    refused (`targetMissing`, page ids only).
  - **Lint is one check per page head, not one per head commit.**
    `merge_request_checks.head_revision_id` already names a page, so no column
    was needed. A write re-lints only the page it touched. The gate holds while
    any page's would, and superseding and thread reconciling run per page. A
    lint thread's page is its anchor's revision.
  - The breaking-API acknowledgement pins the source branch's head commit
    (`breaking_ack_commit_id`). `breaking_ack_revision_id` is still written for
    the previous image. The API changes panel describes the first changed spec
    page the reader may open, and `blocked` answers for every spec page.
  - The atomic merge stages each page's draft and bytes before the transaction.
    Inside, it locks the branch rows in id order, re-checks every head and
    finalizes with `commit: false`. `recordRevisions` then writes one commit for
    all pages, whose second parent is the source branch's head commit. Two S3
    reads per page (finalize's HEAD and GET) still run inside. A failed merge
    deletes the drafts it staged.
  - Threads carry `documentId`, and a thread on a page the reader cannot open
    is left out of the list, because its excerpt quotes that page.
  **1b-2b as built** (the draft fold, [66](66-drafts-publishing.md)):
  - `myDraftBranch` looks for this page's own live draft first, then the
    caller's newest live `draft/<userId>[-n]` project branch, then the first
    free name. Drafts from before the fold therefore stay per page until spent,
    and nothing is migrated.
  - A draft is folded into only when every page branch of it is the caller's.
    Branch names are free text, so `draft/<someone>` could otherwise be planted
    to ride along with their Publish.
  - Spent is judged on the project branch: an MR merged or closed from any of
    its page branches spends them all.
  - A page joining a draft with an open MR is created readable (not
    `restricted`), because the MR's diff shows it to the page's readers.
  - `onTopOf` is a list of reviewed target heads, matched by revision id, so it
    needs no page map. The `diverged` body gains `sourceHeadRevisionId`.
  - Publish from a page the draft does not change opens the MR from the first
    page it does change (edit required there), so the feed and threads land on
    a changed page.
  - `mine` returns `pages` (ids of the pages with revisions on the draft) for
    the "Publish N pages" label. It does not apply the merge-base test that
    `sourcePages` callers do, so it can count a page whose head the default
    branch already holds.
- **Decided for 1b** (issue comment of 2026-10-30): `draft/` folds per person
  and project, and Publish says "Publish N pages" and merges them as one merge
  request. A page first written on the draft forks at the default head at that
  moment, and reads as the default head before then. A spent draft keeps its
  row, and the next one takes the next number.
- **The default branch's tree stays `documents`' truth.** A branch carries its
  own tree in its change rows. A `git mv` or `git rm` on a branch changes
  `documents.parent_id`, `path` or `archived_at` only when it merges into the
  default branch, as the issue says for `git rm`.
- **Feature 66 under the fold** (decided above). A person's working branch
  spans every page they have edited, so Publish on one page publishes all of
  them. Doc 66 says how (1b-2b).

### Phase 2 — 3-way merge and "update"

- `node-diff3@3.2.1` (MIT, no dependencies, 184 KB unpacked) with
  `excludeFalseConflicts: true`. Agreement with git is what matters, and the
  probe measured it. `diff@9` has no merge, and `applyPatch` searches offsets,
  which on a page with repeated lines can land a hunk in the wrong place.
- The issue's web **Rebase** cannot rewrite the source branch: history is
  append-only, and fetchers of that branch would see a forced update. It
  becomes **Update branch**, a merge of the target into the source (parents:
  source head, target head). It is clean whenever the MR's own merge would be,
  and every fetcher fast-forwards. A conflicting MR shows the conflict view and
  the `git pull` recipe.
- **As built** (one PR). `threeWay` (`documents/three-way.ts`) takes `target`
  as ours, so its markers read like `git merge <source>` on the target. It
  splits lines keeping their `\n`, and closes a side that lacks one before the
  next marker. `merge()` and `publishBranch()` compute every page's body with
  `mergedBodies` where the fast-forward check stood. The first stage is unchanged,
  and the only new reason is `conflict` (`conflicts`: page ids and line-range
  hunks, never text). `diverged` remains for a head that moved while the merge
  landed. `GET :id/conflicts` and `POST :id/update-branch` (`resolutions`:
  whole body + the target head it was resolved against) are mirrored in MCP by
  `knowledge_get_merge_request includeConflicts` and
  `knowledge_update_merge_request_branch` (a `WRITE_TOOLS` entry). Where the
  build differs from the plan above:
  - `onTopOf` survives as the conflict override (decided 2026-10-30): a
    conflicting page lands the author's body over a head they reviewed. A
    clean page ignores it.
  - Spec pages merge line-wise like markdown. A merged spec that does not
    parse is refused by finalize's validator, and the merge rolls back. It is
    not reported as `conflict`.
  - `finalizeRevision` takes `dedupe: false` for Update branch, so a resolution
    equal to the source head still writes the merge node that moves the base.
  - No `git pull` recipe yet: there is no remote to pull from until phase 3. The
    conflict view resolves in place on the git-marker text instead, and the
    recipe arrives with the Clone button (phase 5).
  - Merge revisions are still authored by the stub, as before. The merger is
    on the project commit.

### Phase 3 — read side

As planned, plus: the `git-runtime` image stage, a `git` compose service and
volume (profile-gated like `learner`), `handle /git/* { reverse_proxy git:3002 }`
in `Caddyfile`, and the entrypoint and dependency-cruiser rows. `git` joins
`WORKSPACE_FEATURES`. Env: `GIT_REMOTE_ENABLED` (default `false`; off means the
service is not started and `/git/*` 404s), `GIT_CACHE_DIR` (default under the OS
temp dir), `GIT_NOREPLY_DOMAIN` (default `knowledge`, giving
`users.noreply.knowledge`). Changing the noreply domain changes only new
commits, since old headers are frozen. Release tags become **lightweight** tags
at the last default-branch commit at or before `release_tags.at` (tags are
timestamps, not revisions). A workspace-level tag appears in every project. A
name git refuses (`git check-ref-format`) is skipped and logged. Repack a cache
after a cold build and then by `git gc --auto`.

### Phase 4 — write side

As probed, plus [finding 3](#3-a-private-draft-page-cannot-be-in-history-before-it-is-published)
(no new files on a direct default-branch push),
[finding 4](#4-git-does-not-always-send-accept-language) (locale fallback) and
[finding 7](#7-pushed-author-lines-are-the-pushers) (the author-email decision).
A pushed page's title, for a new page, is its frontmatter `title:`, else its
first `# ` heading, else its filename. Verifying the pushed commit renders back
uses the cached parent tree, not the probe's full scratch render. Deleting a
branch over git is refused in v1.

## Numbers

Synthetic projects from `synth.mjs`, with a nested page tree, edits, two-page
merges, moves and archives. "Bob" cannot see one restricted subtree.

| Project | Commits / merges | Cold render (all · bob) | Pack + index | Objects | One new commit | After `repack -a -d -f` | Local clone |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 pages | 446 / 32 | 22 ms · 20 ms | 68 ms | 1,587 | < 1 ms + 16 ms | 652 KB, not repacked | 71 ms |
| 500 pages | 6,667 / 389 | 2.2 s · 1.9 s | 1.8 s | 26,697 | 1 ms + 19 ms | 30 MB → 3.6 MB in 0.8 s | 0.3 s |
| 2,000 pages | 26,842 / 1,614 | 51.7 s · 45.3 s | 23.3 s | 112,254 | 30 ms + 37 ms | → 19 MB in 8.8 s | 1.4 s |

For scale, the largest project in the laptop's dev database has 93 pages and
124 revisions. Production's were not read.

**The ceiling** is a cold build on a large project: the first fetch for a new
visible set renders the whole history before `info/refs` can answer. The cost per
commit grows with the page count (0.3 ms at 500 pages, 1.9 ms at 2,000), which
points at copying the root directory per commit and at flattening state. Production's ingress (a Cloudflare
Worker in front of Funnel) answers 524 when the origin has not responded within
about 100 s. Phase 3 persists a cache (pack plus a commit-id → SHA map) on its
volume so a restart is never a cold build, and renders new commits for
already-built visible sets as they are written. **Upgrade trigger:** a cold
build over 10 s in production, or any project past 1,000 pages. At that point
the build moves off the request path (a `Retry-After` answer while it runs) and
the root-copy cost gets profiled. Memory was not measured. Pushes and clones
through the production ingress were not tried.

## Not settled by the spike

- Memory of a cold build, and pushes and clones through the Cloudflare Worker.
- The JSON spec id form, the YAML form on push, and nested moves within one
  commit (the probe's tree surgery handles one move per subtree per commit;
  phase 3 re-derives an affected subtree from state instead).
- The author-email rule (phase 4).
