# 13 — Review mode

> **Superseded in part.** Feature 15 moved annotation onto ProseMirror
> decorations, and `components/merge-requests/text-anchor.ts` and
> `ReviewCanvas.vue` have since been deleted as dead code. The quote-based
> anchoring model, the contract and the reasoning below all still hold — the
> projection now lives in `components/editor/extensions/comment-anchors.ts`
> with the shared matcher in `lib/anchor-match.ts`.

> Оригинал: «Режим редактора при ревью mr (открывается просмотр документа и
> дается возможность оставлять комментарии, как в pdf файлах / figma:
> подсветка прокомментированной строки, tooltip меню со списком сообщений)»

## What this is

A **Review** tab on the merge request, sitting between Overview and Changes.
It renders the page at the merge request's source head — through the ordinary
read-side renderer, with its tables, panels, mermaid diagrams and glossary
links intact — and lets a reviewer comment on it the way an annotated PDF or a
Figma frame works:

- select any passage → a floating **Comment** button → a composer;
- every commented passage stays highlighted, carrying its comment count as a
  small pin;
- click a highlight → a popover with that passage's threads, where you reply
  and resolve without leaving the page.

Threads created here are ordinary review threads. They appear in the Overview
timeline, count towards the unresolved-thread badge on the merge widget, and
are readable over MCP like any other.

## Why

The Changes tab answers *what changed*. It cannot answer *does this read
well*, which is most of what documentation review actually is. Reviewing prose
through a unified diff means reading the page in fragments, out of order, with
the markdown syntax showing and every rich block reduced to its source — and
a table or a diagram, the parts most likely to be wrong, are exactly the parts
a text diff renders least usefully.

## Decisions

**Anchors are quotes, not positions.** Rendering has no line numbers, and the
ones the diff uses do not survive it. A review comment stores the passage it
was left on plus ~48 characters of context on each side — the W3C
`TextQuoteSelector` shape — and is re-found by searching for it. That survives
reflow, a paragraph inserted above, and a whole section being moved; a line
number survives none of those. This is a fourth `MergeRequestThreadAnchor`
variant (`text`), alongside `line`, `section` and `entity`. The column that
stores it is already `Json` with a `String` type tag, so there is **no
migration**.

**Matching runs against a whitespace-collapsed projection of the DOM.**
`components/merge-requests/text-anchor.ts` builds the page's visible text with
whitespace runs collapsed, alongside the exact `(text node, offset)` each
character came from. The collapse is what makes an anchor portable — the same
passage yields different runs of spaces depending on where the source line
broke — and the point map is what turns a string match back into a real
`Range`, so the highlight lands on the actual words rather than on a
paragraph. Block boundaries contribute a synthetic space, so `</p><p>` cannot
glue two words into one false match.

**Ambiguity is resolved by context, never by guessing.** A term repeated ten
times on a page still highlights the occurrence someone commented on: every
candidate is scored by how much of the recorded prefix/suffix still matches.
When the passage is gone the anchor simply does not resolve — the thread is
reported outdated and falls back to the timeline. An anchor is never silently
re-attached to text nobody reviewed, which is the same promise the `line`
anchors already make.

**Highlights are `<mark>` per text node, applied after render.** A range that
crosses elements cannot be surrounded by one node without rewriting the tree,
so each crossed text node gets its own mark and the wrapping runs back to
front (splitting a later node cannot then invalidate an earlier offset).
Threads are placed one at a time with the projection rebuilt between them, so
two people highlighting the same sentence produce nested marks rather than a
fight. `MarkdownView` gained a `rendered` event for this: decorations attach
after every other pass, or they would decorate markup that is about to be
replaced.

**Nothing is stored in the document.** The marks live only in the reader's
DOM. Review annotations never touch the revision's bytes, so a merge request's
content is exactly what will be merged.

## Shape

- **contracts** — `MergeRequestThreadAnchor` gains
  `{ type: 'text'; revisionId; quote; prefix?; suffix? }`.
- **API** — `ThreadAnchorDto` accepts the new type plus `quote`/`prefix`/
  `suffix` (quote capped at 1 000 chars: a whole-page selection is a comment
  on the page, and the canvas offers an unanchored thread for that);
  `MergeRequestThreadsService.validateAnchor` normalizes the quote's
  whitespace exactly as the client's projection does, so an anchor written by
  one browser resolves in every other. No new endpoint, no schema change.
- **Web** — `components/merge-requests/text-anchor.ts` (projection, anchor
  creation, resolution, highlighting), `ReviewCanvas.vue` (the tab's body: the
  rendered page, the selection affordance, the discussion popover),
  `MergeRequestDetailPage.vue` (the tab + the source-head content query, only
  fetched on that tab), `ThreadCard.vue` (a text anchor labels itself with its
  quote), and the annotation styles in `styles/editor.css`.

## Limits

- Anchors resolve **client-side**, so a thread's staleness is known only once
  the page has rendered. The detail page unions the outdated sets reported by
  the diff and by the canvas before handing them to the timeline.
- Resolution is exact-match on the collapsed text. An edit *inside* a quoted
  passage orphans its thread (reported outdated) rather than fuzzily
  re-anchoring it — deliberate, per the "never re-attach" rule above.
- The popover is positioned against the canvas, not the viewport, so it
  scrolls with its passage; it does not flip when a passage sits at the very
  bottom of a long page.
