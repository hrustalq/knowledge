# 32 — Drag-and-drop in the page tree

Оригинал: «we should implement dnd logic for documents tree sidebar to manage
their ierarchy — a full dnd support with freezing, animations, error handling,
just like on folder manage on any OS»

## What

The page tree reorganises by dragging. Drop a page **onto** another to file it
under that page; drop it **between** two to set its order among their siblings.
Both trees do it — the rail's `SidebarTreeNode` and the pages index's
`DocumentTreeNode` — because both draw the same store.

Alongside the pointer gesture, and for the same job: a keyboard drag (Space,
arrows, Enter, Escape) and a **Move to…** picker in a new per-row `⋯` menu.

## Why the position column had no write path

`documents.position` already existed, indexed as `[parentId, position]`, and
`getTree` already ordered by it. Nothing could set it. Ordering was therefore
whatever `createDocument`'s append-on-create had left behind, permanently.

Worse, `updateDocument` re-parented a page without touching its position, so a
page moved into a new parent carried its old index in with it, collided with
whichever sibling already held that index, and fell back to the `title`
tiebreak — landing somewhere nobody chose. Feature 08 listed "move-by-drag in
the tree" as future work; this is that work, and the collision is why it could
not simply be layered on top.

## Decisions

**A separate route, not a `position` field on `PATCH :id`.** Ordered placement
is a multi-row renumber, and the house rule is that idempotency is a single
guarded statement. A partial update carrying a bare index cannot be one: two
concurrent drops would each write an index computed against a tree the other had
already changed, and both would succeed.

**`beforeId`, not an index.** The request names the sibling the page lands
*above* (`null` appends last). An index is computed against the client's copy of
the tree, so it is already wrong if anyone moved a row in between — and it fails
*silently*, landing the page one slot off. An id either still names a child of
`parentId` or it does not, and the second case is a `409` the caller can act on.

**The renumber rewrites the whole run, not a range.** A shift (`position + 1`
for everything at or after the insertion point) is cheaper and preserves the
collisions the run inherited from the bug above. Rewriting every row in the
destination run — and the run the page vacated — means moving a page is also the
repair. A tree that has accumulated duplicate positions heals as it is used.

**Optimistic, with only the moved subtree locked.** The row lands before the
request goes out. Freezing the whole tree would be simpler and is what "freezing"
usually means, but it blocks navigating away from a move you have stopped caring
about; freezing nothing would let a second drag race the first. On failure the
node returns to the exact index it left — which is why `detach` reports one
rather than just removing the node.

**Remote invalidation waits for the drag.** `documents.invalidate()` replaces
`tree` wholesale. Mid-drag that deletes the row under the cursor and every rect
the hit test holds, so the store queues the request and answers it on drop.

**Below an expanded row, "after" means its first child.** The gap under an open
parent visually belongs to the branch, not to the parent's next sibling.
Resolving it as the sibling is the single most common way a tree drag surprises
the person doing it. The drop indicator's inset is what says which one is meant
— the same gap, a different indent.

**Hierarchy still does not enter the graph.** Features 08 and 11 stand: a move
rewrites `parent_id`, `path`, `depth` and `position` in PG and nothing else. No
`PART_OF` edge, no re-embed, `EMBED_RECIPE` untouched.

## API

```
POST /v1/documents/:id/move        @Access('editor', 'document')
{ parentId: string | null, beforeId?: string | null }
```

One transaction: `assertValidParent` (the existing cycle check, which is why a
drop onto a descendant is refused server-side and not only by the dragging
client) → renumber the destination run → renumber the vacated run → write the
row → re-path the subtree.

`repathSubtree` is now shared by `updateDocument` and `moveDocument`. One
implementation because the `substring` offset and the depth delta have to agree
with the path the row itself was given; two copies of that arithmetic is how a
subtree ends up at a depth its own parent disagrees with.

## Web

| File                             | Role                                               |
| -------------------------------- | -------------------------------------------------- |
| `knowledge/tree-dnd.ts`          | `provideTreeDnd` (one per tree) + `useTreeDndRow`   |
| `knowledge/TreeDragLayer.vue`    | The pointer ghost and the `aria-live` announcer     |
| `knowledge/TreeRowMenu.vue`      | The `⋯` menu                                        |
| `knowledge/MoveToDialog.vue`     | Destination picker                                  |
| `stores/documents.ts`            | `moveDocument`, `moving`, the drag-aware invalidate  |

**Pointer Events, not HTML5 drag-and-drop.** HTML5 gives a drag image you cannot
style, no hook to auto-scroll a container, and touch support that varies by
browser — and none of its machinery helps the keyboard path, which §2.5.7
requires anyway.

It lives under `components/` rather than `lib/`: the controller resolves drops
against the store, and `lib/` is a leaf layer that may not reach into app state —
dependency-cruiser enforces it.

**Rows nest, so every handler is scoped to the innermost row.** `pointerdown`
and `keydown` bubble through every ancestor row. Unscoped, grabbing a deep page
starts a drag of its outermost ancestor, and one arrow press during a keyboard
drag steps as many slots as the page is deep. `isInnermost` is the guard, and it
lives in the composable so neither tree can forget it.

**The horizontal window travels for a keyboard drag only.** `tree-window.ts`
slides the rail past a depth budget, and the keyboard target moves deliberately,
so revealing it is right. Under the pointer it is a feedback loop: panning the
list changes which row sits under a stationary cursor, which resolves a
different target, which pans again — the target oscillates and every frame
invalidates the layout that the next frame's rect pass depends on. The cursor is
the authority in a pointer drag, so the view holds still.

**Auto-expand is undone if abandoned.** Hovering a collapsed branch for 600ms
opens it. Branches on the path to the actual drop stay open — that is where the
page went — and everything else this drag opened closes again. A gesture that
silently rearranged what was open would make the tree untrustworthy.

## Accessibility

WCAG 2.2 §2.5.7 (Dragging Movements) needs a single-pointer alternative to every
drag. There are two, because they serve different people:

- **Keyboard drag.** Space on a focused page title grabs it; ↑/↓ walk the
  insertion point; →/← change nesting depth; Enter commits; Escape restores. Each
  candidate position is announced in full (`"Billing API: before Search API, in
  Contracts"`) — "moved down" would say the key registered, not where the page
  would land. Space rides the title link, which is the row's existing tab stop:
  a second focusable element per row would double every tab traversal of the rail.
- **Move to….** For the mouse user who cannot hold a drag steady, which is most
  of the people the criterion was written for. It offers destinations, not
  positions; ordering is what dragging and the arrow keys are for.

Reduced motion keeps the ghost tracking the pointer — that is the cursor, not
decoration — and softens only its arrival.

## Deliberately not built

- **Multi-select drag.** The tree has no multi-select, and inventing one to serve
  a drag is a larger change to navigation than to dragging.
- **Cross-project drag.** `PATCH :id` already moves a page between projects and
  `moveDocument` deliberately does not: the projects are separate trees in the
  rail, and a drag across that boundary needs a confirm affordance this feature
  did not want to design in passing.
- **Undo.** A failed move rolls back; a successful one is undone by dragging it
  back. A general undo stack belongs to the app, not to this gesture.
