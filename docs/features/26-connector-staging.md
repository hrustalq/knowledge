# 26 — Connector staged tree import

## What this is

A connector pull stops being a number that goes up and becomes a place you can
stand in. `/settings/connectors/runs/:runId` shows the external hierarchy
filling in branch by branch, and lets a reviewer stop it, read what it proposes,
correct a page, and approve a section at a time.

Three things make that possible, and each of them is a change in kind rather
than in degree:

| Before                                | Now                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Confluence flat-listed a space        | Both Confluence adapters **walk the tree** (`children()`, `tree` capability) |
| A run was counters on a row           | **Every page is a row** — `connector_run_items`, self-FK `parent_item_id`    |
| Pages were written as they were read  | `sync_mode` `auto` \| `review` \| `step`, with a real **pause**              |
| A bad import was somebody's afternoon | **Revert**, per page or per branch                                           |
| A stopped walk was a dead run         | **Fill** what it found — all of it, or one node or branch — while paused    |

The backend shipped first; this feature is the surface over it. Nothing about
`auto` mode changed, and `preserve_hierarchy` defaults to **false**, so a
connector configured before this feature pulls exactly as it did.

## Why

A pull from a wiki is not a transfer. It is an edit to somebody's knowledge
base, made by a machine, at a scale nobody reads afterwards.

The old path made that worst-case easy to reach. A Confluence space flat-listed
into a few hundred pages, every one of them written immediately as a sibling
under a single parent — so the structure that made the space navigable was
discarded on the way in, and the first time anyone saw the result was after it
existed. There was nothing to review, nothing to stop, and nothing to undo
except deleting pages by hand. The happy path logged nothing, so when it went
wrong the only evidence was the wreckage.

Everything here follows from taking that seriously: if a machine is going to
write three hundred pages into a knowledge base, a person should be able to
watch it, stop it, and take it back.

## Decisions

**Every page is a row.** `connector_run_items` is modelled on
`workflow_run_nodes` and exists for the same reason that table does: the feature
has to answer _"which items in this run are awaiting review"_, and an opaque
blob on the run cannot be queried. The markdown lives in MinIO
(`workspaces/{ws}/connector-runs/{runId}/items/{itemId}/{staged,incoming}.md`),
not in the row, so the query the wizard polls stays small.

**Staging and applying are separate calls even in `auto` mode**, where they
happen back to back. One code path means a reviewed import and an unattended one
produce identical results, rather than the review path being a second,
less-tested implementation of the same thing.

**`unchanged` is not `skipped`.** The first means the two sides already agree;
the second means a person declined it. Collapsing them would make "what did this
run actually leave alone" unanswerable — and on a second sync, _almost every row
is `unchanged`_, which is exactly how a reviewer sees at a glance whether the
connector is idempotent or whether something is churning. The tree's count line
exists for that one reading, and `unchanged` is deliberately the quietest colour
in the set so the two rows that did change are the ones the eye lands on.

**The buttons and the transitions are one list.** `allowedRunEvents(run)` and
`allowedItemEvents(item)` live in `@knowledge/contracts` and are called by the
API and by the web. Nothing in a component re-derives an enabled state from
`status` — that is the `allowedNodeEvents` idea from `@knowledge/workflow`, and
the point of sharing the table is that the two cannot drift.

**Hierarchy is opt-in, and a skipped parent is transparent.**
`preserve_hierarchy` defaults to false so no existing connector moves; turning it
on never relocates a page already imported. When a parent is skipped its children
re-root rather than being stranded — an item whose parent never arrives is
attached at the root of the rendered tree for the same reason. A row that exists
and renders nowhere is how a page silently goes missing from a review.

**AI is per-item and never automatic.** `cleanup` repairs the conversion;
`merge` is offered only on a `conflict` item and is three-way against the last
agreed revision. Both are routed through the existing `drafter` agent — no new
built-in — and **an item whose `aiOp` is set carries a visible badge**, in the
tree and in the review rail. A page a model rewrote must never be
indistinguishable from one Confluence sent. The unedited conversion stays on the
server as `incoming` and is one disclosure away throughout.

**Revert asymmetry is deliberate.** A created page is torn down through
`ProjectCascadeService.cascadeDocuments` — the product's only page-delete path —
while an updated one is restored by writing a **new** revision. Revisions are
immutable; undoing an edit by deleting one would be the first place in the
product that violated it. The link's hashes roll back too, or the next sync would
immediately redo the undo.

**A pause stops the walk, not the review.** Content is read in a phase that
begins only once the whole tree is walked, so a run paused during discovery used
to be hundreds of rows with no content and nothing anyone could do — and
approving a page while paused marked it `approved` and never wrote it, because
applying started only from `awaiting-review`. Two verbs fix that, and both are
about *not* being held hostage to the rest of the space: **`FILL`** ends the
walk and reads what it found (the phase pointer moves past `discovering`, which
is only ever read forwards, so discovery cannot resume), and item **`FETCH`**
reads one node, or one branch through the existing `subtree` flag.

**Work asked for by a person rides on the job payload, never on the run row.**
`phase` is the checkpoint and `cursor` is the discovery frontier; filling a
branch or writing an approval must not be able to move either, or a paused walk
loses its place. So `ConnectorJobData.task` carries `fill` / `apply` — the
`payload.reason='dependent-reindex'` precedent — and a task job skips the
`status: 'queued'` claim the run's own slices take, because claiming would
un-pause the very walk somebody stopped. Concurrency is still safe without it:
the per-item `updateMany … where status:'discovered'` claim is the mutex, and it
already existed. `stageBatch()`/`applyBatch()` are shared by both paths, so
filling a chosen branch is the same code as filling the whole tree.

**Nothing staged is two different facts, and neither is an empty conversion.**
A `discovered` item has not been read; an `unchanged` one agreed with the page
and so was never staged at all. Both landed on an empty editor captioned *"the
conversion produced no text"* — false in the first case, misleading in the
second, and on a second sync *almost every row is `unchanged`*, so that caption
was what the whole run looked like. `discovered` now says so and offers the
fetch; `unchanged` renders the page as it stands, which is the only thing there
is to show. `getItem` loads `localHead` for it for that reason, and `compare`
returns null in both states — diffing a page against an empty string reports
every line deleted, the opposite of what either means.

### Surface decisions

**The run page is the import wizard's frame.** Fixed header, a body that flexes
to fill what is left, one action bar pinned to the bottom. The panes inside
differ enormously in height — a tree of three rows or three hundred, a progress
ring, a full editor — and without a fixed frame the run controls would wander
down the page every time the worker found something. The bar carries the _run_'s
controls only; per-item actions live on the item, because they are about one
page while Pause and Cancel are about all of them.

**The review pane is `ImportReview`'s shell**, deliberately: title in the
editor's lede slot, prose column owning the scroll, rail down the side. A
connector pull is an import that happens repeatedly, and correcting a heading a
converter guessed wrong should be the same gesture here as on the page tomorrow.

**The item tree nests; the workflow run tree flattens.** Opposite problems. A
generated chain is a dozen nodes that should all stay visible; a Confluence
space is hundreds of pages a reviewer works through one section at a time, so a
branch here genuinely collapses. It is also not the sidebar page tree it
otherwise resembles: **there a twisty is a load, here it is a fold**, because
the whole item list arrives in one response. `hasChildren` with no rows beneath
it therefore means something else entirely — the adapter said this branch
continues and the walk has not reached it yet — and reads as a discovery hint,
never as a collapsed branch nobody can open.

**Progress reuses `ParseProgress` unchanged.** It already encodes the rule this
needs: the worker owns this half, so report `null` rather than a number the
client invented. Discovery is unbounded and gets the sweep; fetching is
`done / discovered` and gets the fill. That handoff is the same one the import
wizard animates, and it means the same thing here.

**A `conflict` item opens on the diff, not the editor.** Both sides moved, so
the first question is not "is this prose right" but "what am I about to
overwrite" — which an editor cannot ask. The editor is one click away and is
what the merge assist writes into.

**A local differ rather than a diffing dependency.** Every diff in the product
until now was between two revisions, and the server computes those. A staged
item is neither side of that: markdown that does not exist yet, against a page
head that does — no revision id, so no endpoint to call. `lib/line-diff.ts`
produces `DiffHunk[]`, the same shape the compare endpoint returns, and
`DiffView` renders it unchanged. Myers is not implemented: trimming the common
prefix and suffix collapses the realistic case to a few lines either side, and
past a bounded LCS table the honest answer is "this side was replaced", which is
also what a reviewer would conclude from a diff where every line is marked.

**`rootPageId` rides along with the space question** rather than taking a setup
step of its own. It refines _which space_ — sync this subtree, not all of it —
exactly as `subdir` refines markdown-git's repository, and that step already
carries two optional fields. A step per optional field makes everyone press Next
past a question most connectors never answer.

**New tree-walking connectors are offered `review` + `preserveHierarchy`,** but
only new ones, and only as prefilled controls. Editing an existing connector
reads its stored values, or opening the dialog to rename a connection would
silently re-shape its next run. The defaults are read from
`CONNECTOR_KIND_INFO.capabilities.tree`, so the catalogue the API validates
against stays the single place a capability is declared.

**`subjectId` means two different things on the `connector.*` event prefix.**
`connector.run.started|succeeded|failed` carry the _connector_ id;
`connector.run.paused|resumed|awaiting-review` and every `connector.item.*` carry
the _run_ id. The live-cache rule invalidates both readings — the id is a uuid
either way and a miss costs nothing, where guessing wrong silently never
matches. The asymmetry is load-bearing, not an oversight, and is commented where
it bites.

## Deliberately not done

- **No virtualization.** `@tanstack/vue-virtual` is in the repo but used on flat
  lists only, and `CONNECTOR_SYNC_MAX_ITEMS` caps a run at 1 000 rows. A
  virtualized tree with collapsible branches is a real amount of machinery for a
  bound we already enforce.
- **No bulk selection.** Approve-branch and Approve-all cover what people
  actually do; a checkbox column would be a third selection model on a page that
  already has one.
- **No three-way content merge in the UI.** Same boundary the backend draws:
  merging is fast-forward-preconditioned, and the assist is an assist.
- **Push is untouched.** Staging a push is a different feature with a different
  reviewer, and pretending otherwise would have meant one screen serving two
  audiences.

## Verification

`make check` passes; `make api-client` regenerates cleanly. Two self-checks ship
as plain assert scripts, the house pattern where there is no test runner:

```bash
node --experimental-strip-types apps/web/src/components/connectors/setup-machines.check.ts
```

covering the wizard spine, Back in every position, the persistence round trip,
the stepper arithmetic, and now the staging defaults — including that editing an
existing connector does not re-offer `review`.

The differ and the Russian plural forms were verified the same way while
building, and both found real defects: an empty document read as one empty line
(a phantom deleted line against every `create` item), and four new plural
strings whose Russian slot 0 is the _zero_ case, not the singular — so `1
страница` had been landing on the "few" form.

End-to-end, against a Confluence Server space with at least three levels and
`CONNECTOR_DEBUG=true`:

1. A `review` pull fills the tree branch by branch, matching the real hierarchy.
2. **Pause** mid-discovery stops within one item; **Resume** continues rather
   than restarting. Same with **Next** in `step` mode.
3. While paused mid-discovery: **Fetch** on one node, and **Fetch branch** on a
   section, fill only those — siblings stay `discovered`, the run row still
   reads `paused`, and `cursor` is untouched, so a later **Resume** continues
   the walk from the frontier. Approving one of them writes the page and leaves
   the run paused.
4. **Stop walking, fetch what was found** ends discovery for good, fills every
   row it had, and records how many branches went unread.
5. Editing a staged item and running **cleanup** shows the AI badge, and
   `incoming` still holds the original.
6. Approving a subtree nests pages as Confluence has them, and a **skipped
   parent leaves its children re-rooted, not stranded** — a page re-rooted
   because its parent is merely *unread* says so in its warnings.
7. **Revert** deletes a created page with its link, and gives an updated page a
   new revision restoring the old content.
8. **Syncing twice** reports every item `unchanged`, creates nothing, and
   produces no duplicate pages, item rows or parent changes. This is the single
   most important check, and the tree's count line is where it is read. Every
   one of those rows shows the page as it stands, not a blank editor.
9. A connector left at `preserveHierarchy=false, syncMode='auto'` pulls exactly
   as it did before the feature.
