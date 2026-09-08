# 15 — Page comments and the issue-shaped page

## What this is

The document page, rebuilt around reading rather than around tabs, plus
commenting on the page itself.

The old page put the content in a tab next to Overview, Revisions, Merge
requests, Graph and Activity — so reading the page was one option out of six,
and every other tab hid it. This version borrows the shape an issue tracker
uses: one main column read top to bottom, and a rail beside it.

**Main column** — the content, and nothing else. Every fact *about* the page
(revision, status, category, type, hash, finalized, relations, frontmatter)
moved into the rail, where it can be read without pushing the page down.
**Rail** — Overview, Frontmatter, History, Changes, Graph and Activity as a
*stack of collapsible widgets*, not tabs. Collapsed, each is one scannable row
carrying the fact that decides whether to open it: `#2`, `1 field`,
`2 revisions`, `none`, `45 relations`, `4m ago`. With tabs, five of those six
answers are always hidden behind a click.

Overview is open by default — it is what a reader checks before trusting a page,
so it should not need asking for. Frontmatter appears only on pages that have
any; a widget for nothing is furniture.

The body of a widget mounts only while open — the graph builds a Cytoscape
instance, and a rail that instantiated all four on load would make the page
slower to read for the sake of things nobody asked to see. A **Maximize**
control reopens a widget in a dialog, because a graph or a revision table needs
width the rail does not have and sending the reader to another page to get it
loses their place.

Two things changed inside the main column:

- **The content is the editor in read mode.** `RichEditor` with
  `editable: false`, not the static renderer — so what you read is literally
  what you would edit, with live node views for diagrams, whiteboards, tables
  and expands.
- **Any passage can be commented on**, the way an annotated PDF or a Figma
  frame works. There is no discussion list under the content: comments live on
  the text, and nowhere else.

Two ways in:

- **Select a passage** → a floating **Comment** button appears at the selection
  → a composer, anchored to exactly those words.
- **Hover a block** → a comment control appears in the reading gutter beside it
  → a composer anchored to the whole block. This is the affordance Notion,
  Figma and Docs use, and the reason none of them open a composer on hover
  itself: a box that appears wherever the pointer rests fires continuously
  while someone is reading.

  The control persists until another block claims it, and only leaving the
  article dismisses it. This is the whole difficulty of a hover affordance:
  travelling to the control means leaving the block that summoned it — the
  pointer crosses the gutter, where the target is padding rather than any
  block, and then the control itself. Clearing on either kills the thing the
  pointer is reaching for, so "no block here" has to mean "nothing changed",
  not "nothing is hovered".

Commented passages stay highlighted with a comment-count pin; clicking one
opens a popover with its threads, where you reply and resolve. The rail's
"N open comments" scrolls the first one into view and **flashes** it — arriving
at a paragraph without knowing which words were commented on is the same as not
arriving.

## Why the highlights are decorations, not markup

Review mode (feature 13) highlights passages by wrapping them in `<mark>`
elements injected into the rendered HTML. That cannot work here: the reading
surface is ProseMirror, which owns its DOM and reconciles away anything written
into it from outside.

So the same highlights are expressed the way ProseMirror expects — inline
decorations over document positions
(`components/editor/extensions/comment-anchors.ts`, on Tiptap's `addDecorations`
hook with `update: 'manual'`, redrawn by a command when the thread set changes
rather than on every keystroke). They survive editing for free.

Anchoring itself is unchanged and deliberately shared. The quote-matching
algorithm moved to `lib/anchor-match.ts` — normalize whitespace, find every
occurrence of the quote, score each by how much of the recorded prefix/suffix
still matches, take the best — and both projections feed it: the DOM projection
in `text-anchor.ts` (review mode) and the ProseMirror projection in
`comment-anchors.ts` (this feature). They agree character for character —
whitespace collapsed, one synthetic space at each block boundary — so an anchor
written by one resolves in the other. An unresolvable quote is reported
**outdated** and never silently re-anchored: a comment moved onto text nobody
wrote it about is worse than a missing one.

Selection capture is the one place the DOM still leads, because a read-only
editor keeps no ProseMirror selection to read. The browser supplies the quote
string; everything else — the match, the context — comes from the document
projection, which is also the guard: a selection that drifted into something
the document has no text for (a diagram's rendered labels, the comment UI)
produces a quote that does not resolve, and the caller offers an unanchored
comment instead of storing a pin that will never be found again.

## Read metrics

The reader is the editor with `editable: false`, so it inherits the authoring
metrics — and all three are wrong for reading. `.kn-read-surface` overrides
them: the 2rem lead-in and 6rem of trailing room for a cursor go, the centred
736px measure goes (inside a column the rail has already narrowed it reads as
two thick margins rather than as typography, so reading fills the column it was
given, flush with the title above it), and `min-height: 24rem` goes with it — a
short page should simply be short.

Nothing is inset for the comment control: it hangs in the page's own outer
margin. Reserving a gutter inside the column indents every page out of line with
its title, permanently, to make room for a button that is only ever visible
under the pointer — so the control is pointer-and-wide-only (below `lg` the
outer margin is too narrow, and on touch there is no hover), while selecting a
passage works everywhere.

The body also drops its own leading `# Title` when it matches the document
title. `documents.title` is canonical and the header renders it, but nearly
every page also opens by repeating it, because that is what writing markdown
looks like — so the reader met the title twice. A first heading that says
something else is a real section and stays.

## Data model

`document_threads` + `document_comments`, mirroring the merge request pair.
Deliberately a second pair rather than nullable columns on
`merge_request_threads`: the two share a shape but not a lifecycle — a review
thread closes with its merge request, a page comment outlives every revision of
the page it annotates.

The anchor shape is the existing one (`ReviewThreadAnchor`), validated by the
shared `documents/review-anchor.ts` that both services now call.

Contracts grew a `ReviewThread`/`ReviewComment` base that `MergeRequestThread`
and `DocumentThread` extend, which is what lets one `ThreadCard` render either.

## Routes

| Route | Access | Notes |
|---|---|---|
| `GET /v1/documents/:id/threads` | viewer | unresolved first, then oldest-first |
| `POST /v1/documents/:id/threads` | viewer | `{ body, anchor? }` |
| `POST /v1/documents/:id/threads/:threadId/comments` | viewer | reply |
| `PATCH /v1/documents/:id/threads/:threadId` | viewer | `{ resolved }` |

Commenting is a **viewer** action: whoever may read a page may annotate it.
Changing the page still needs `editor`. There is no "open" gate of the kind
merge request threads have — a page has no status to close, so comments stay
writable for as long as the page exists.

Events: `document.comment.created`, `document.comment.resolved`, recorded on the
activity log and published on the live bus like every other thread write.

## Notes

- Commenting is off while viewing a historical revision (`?revision=`): the
  anchor would be recorded against text that is not the head.
- `?tab=` survives as an *opening* instruction rather than two-way state —
  more than one widget can be open, which is not something a single query
  parameter can hold. Every existing deep link still lands with the right
  widget open; the values that used to name a main tab (`overview`, `content`)
  now describe something always on screen and open nothing in particular.
- The comment-count pin is a **widget** decoration, not `::after` on the
  highlight. ProseMirror renders one inline decoration as a span per text node,
  so a CSS pin appears once per fragment — and no selector can distinguish
  "this thread continues" from "a different thread starts here", which is
  exactly what two comments on neighbouring passages look like.
- "On this page" is derived from the rendered editor, which assigns heading ids
  the same way the static renderer slugifies them, so section links work across
  both surfaces.
- `ThreadCard` and `CommentComposer` still live under `components/merge-requests/`
  and are now shared with the document page; they are subject-agnostic and typed
  on `ReviewThread`. The popover threads are deliberately the *same* review UI,
  resolve workflow included — a comment on a page and a comment on a change are
  the same conversation.
- A block's quote is read from a clone with the annotation layer stripped. The
  comment-count pin renders as a real text node inside the block, so plain
  `textContent` produced a quote ending in a stray digit — which matched
  nothing, silently making a block uncommentable as soon as it had a comment.
