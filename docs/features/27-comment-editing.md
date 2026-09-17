# 27 — Comment editing, Comment vs. Start thread

> Follows features [13](13-review-mode.md) and [15](15-page-comments.md), which
> built the two annotation surfaces but left every remark immutable and every
> remark blocking.

## What this is

Three changes to the discussion primitives shared by merge-request review and
page comments:

1. A comment can be **rewritten or deleted by its author**.
2. A remark can be a **plain comment** or a **thread** — GitLab's two shapes —
   and only a thread stands between a merge request and its merge button.
3. The compact composer grew a **formatting toolbar**, so a comment is written
   with the same affordances as the page it is about.

It ships on **both** surfaces because `CommentComposer` already served both, and
a split button that worked on the review tab but not on a page would be worse
than not having one.

## Why a plain comment had to exist

Before this, every remark was a thread, and every unresolved thread counted
toward the merge-request gate. That made "typo in the second paragraph" and "this
endpoint contradicts feature 11" the same weight of object: both had to be
resolved by somebody before the branch could merge. Reviewers responded the way
reviewers always do — by not commenting.

`resolvable` splits them. `false` is a remark that is said and done; `true` is a
question that stays open until someone closes it. `statsFor` and the pages'
`unresolvedCount` count only `resolvable && !resolved`, **so a plain comment can
never block a merge**, and `setResolved` refuses one with a 400 — there is no
state for it to move to.

The column defaults to `true`, so every row written before this feature keeps
exactly the behaviour it had.

## Why the edit is a column and not a new row

`updated_at` is **nullable on purpose**. A non-null value means "edited", and the
_edited_ marker in the UI keys off nothing else. Had it defaulted to `created_at`,
every comment ever written would claim to have been revised, and the marker would
have to be derived by comparing two timestamps that are equal only by accident.

Deletion is a real delete, not a tombstone, but replies survive it:
`replyToId` carries `onDelete: SetNull`, so removing a parent orphans its replies
into the thread rather than cascading them out of existence. A discussion is a
record; deleting one person's line should not delete the answers to it.

## Data model

Both table pairs gained the same two columns — the merge-request set dies with
its merge request, the document set outlives every revision, which is why they
are separate tables in the first place (feature 15).

| Table                                         | Column       | Shape                             |
| --------------------------------------------- | ------------ | --------------------------------- |
| `merge_request_comments`, `document_comments` | `updated_at` | `DateTime?` — null = never edited |
| `merge_request_threads`, `document_threads`   | `resolvable` | `Boolean @default(true)`          |

`replyToId` (`String?`, self-relation, `onDelete: SetNull`) is present on both
comment tables.

## Routes

Added on both subjects, mirroring each other exactly:

```
PATCH  /v1/documents/:id/threads/:threadId/comments/:commentId
DELETE /v1/documents/:id/threads/:threadId/comments/:commentId
PATCH  /v1/merge-requests/:id/threads/:threadId/comments/:commentId
DELETE /v1/merge-requests/:id/threads/:threadId/comments/:commentId
```

**Author-only on both verbs** — anyone else gets a 403
(`error.comment.onlyAuthorCanEdit` / `error.comment.onlyAuthorCanDelete`).
Merge-request edits additionally require the MR to be open, the same rule that
already governed writing a comment there; page comments have no such gate,
because a page has no open/closed state (feature 15).

`PATCH /v1/{documents,merge-requests}/:id/threads/:threadId` continues to resolve
a thread, and now 400s when the thread is not `resolvable`.

## Shape

`CommentComposer` (still under `components/merge-requests/`, serving both
surfaces) gained four things:

- **`offerThread`** — renders a split **Comment ▾** button whose second item is
  _Start thread_. `submit` now emits `(body, resolvable)`; the default is
  `!offerThread`, so a host that never opted in keeps getting threads, and
  one-argument handlers keep ignoring the second value.
- **`initialBody`** and **`cancellable`** — the same box rewrites an existing
  comment in place, with a way back out. An edit that cannot be abandoned is a
  trap.
- An exposed **`expand()`**, which the per-comment **Reply** control calls.

`ThreadCard` shows Reply and Edit on comment hover, and **hides Resolve entirely
when the thread is not resolvable** — offering a control that always 400s is
worse than offering none.

`RichEditor` in `compact` mode now mounts `EditorToolbar`, itself trimmed by a
`compact` prop (no alignment, panels, status, columns, expand or table-of-contents
— the blocks that make sense in a page and not in a two-line remark).

The subtle part is focus. "Focused" is scoped to the **whole composer** via
`[data-kn-editor-shell]` plus teleported menus, rather than to the ProseMirror
node: clicking Bold, or opening the split button, moves focus out of the editor,
and a toolbar bound to editor focus would vanish mid-gesture — exactly when it is
being used.

Both annotation canvases dismiss the discussion popover on a **document-level
`pointerdown`** rather than vueuse's `onClickOutside`. A highlight _opens_ the
popover on click, so a `click`-based listener fires in that same gesture and
closes what the click just opened. A press on another `[data-kn-thread]` switches
passages instead of dismissing.

## Limits

- Edit history is not kept. `updated_at` says _that_ a comment changed, never
  what it said before; the previous text is gone. A discussion that needs an
  audit trail is a merge request, which has one.
- A plain comment cannot be promoted to a thread after the fact, or demoted. The
  shape is chosen when the remark is written.
- There is no edit window and no "edited by" — author-only means the author
  forever, including after they lose write access to the workspace.
