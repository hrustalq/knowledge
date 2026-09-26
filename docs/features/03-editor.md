# 03 — Editor

> Оригинал: «Редактор (как в confluence) с поддержкой ссылок, референсов,
> диаграмм, пдф, виджетов итд»

## What it is (MVP scope)

A markdown editor with live preview that can create documents and publish new
revisions of existing ones — the platform's first authoring surface. Not a
WYSIWYG block editor; see Future work.

## Design

- **Routes**: `/create` (new document) and `/documents/:id/edit` (new revision
  on the default branch).
- **Layout**: two panes — markdown source (textarea + toolbar) and live
  preview (`MarkdownView`, same renderer as the document view, incl. mermaid
  diagrams). Toolbar inserts markdown snippets: headings, bold/italic, code,
  table, mermaid block, link, and **document reference** (picker over the
  workspace's documents that inserts a `/documents/<id>` link).
- **Metadata panel**: title, category (07), parent document (08), and a
  relations editor that writes frontmatter `relations:` — so the deterministic
  extractor (worker step 7) turns them into graph edges with provenance on
  index, no separate API call.
- **Save flows**:
  - create → `POST /v1/documents` with inline content (auto-finalizes, queues
    ingestion);
  - edit → `POST /:id/revisions` with `If-Match: <head>` (optimistic
    concurrency; a 409 surfaces the comparison link), then presigned
    upload + finalize. Editing loads the current head via
    `GET /:id/content` (feature 01).
- **AI panel** (feature 09) sits in the editor sidebar: review + related docs.

## Future work

- Block-based WYSIWYG (TipTap/ProseMirror) mapped to markdown.
- PDF/attachment embeds — requires binary revision uploads + a viewer.
- Live collaborative editing (CRDT) — plan.md keeps revisions immutable, so
  collaboration would happen pre-finalize on drafts.
- Widgets/macros (status, TOC, include-other-doc).

## Since the MVP: streams and the working copy

The block-based WYSIWYG above shipped (Tiptap, `components/editor/`). Two
things were added on top of it.

### Editor events as streams — `components/editor/editor-streams.ts`

Every Tiptap event the chrome reacts to enters through `editorStreams(editor)`,
one ref-counted set of RxJS streams per editor instance:

- `docChanged$` — the `update` event, so a host's `setContent(…, { emitUpdate:
  false })` is never echoed back as an edit.
- `frame$` — transactions, focus and blur coalesced to **one emission per
  animation frame**. Everything that reads layout (the selection bubble's
  `coordsAtPos`, the table bar's `getBoundingClientRect`) listens here, so a
  burst of transactions costs one forced layout, not one each.
- `format$` — the toolbar's view of the selection (`FormatState`: marks, list
  types, heading level, undo/redo/indent availability), read once per frame
  and dropped when unchanged.

`createMarkdownSync` is the model half of the two-way binding: serialize once
typing pauses (200 ms), `cancel()` when a save flushes or the host replaces the
document. It hands turndown the serializer's DOM directly (`docToMarkdown`)
instead of `getHTML()` → string → re-parse, and builds it in a detached
document so serializing a page of images does not refetch them.

**Why:** `@tiptap/vue-3` makes `editor.state` reactive, so a template that
calls `editor.isActive()` re-renders on every transaction. The toolbar did —
the whole bar, per keystroke. The chrome now renders from `format$` and no
template reads editor state. The drag gutter's target is coalesced per frame
the same way.

### Unstaged changes — `lib/working-copy.ts`, `use-working-copy.ts`

Git's vocabulary: publishing a revision is the commit, and until then the
edits are *unstaged*. They used to live only in component state, so a reload
or a crash lost them. Now:

- The page (title, body, placement, relations, tags, message) is written to
  `localStorage` under `kn:unstaged:v1:<workspace>:<document|new>` once
  editing pauses (600 ms), and immediately on `pagehide` or when the tab is
  hidden. A browser that refuses the write (quota, blocked storage) is reported
  in the header rather than claimed safe.
- "Unstaged" is **measured, not flagged**: the current page against the
  published baseline, normalised the way publishing would (`samePage`). The
  baseline is captured after the editor has parsed the page (`@ready` →
  `flush()`), so stored markdown that is not the editor's own spelling does not
  read as a change. Undo back to the head and the stored copy is removed.
- Reopening the page restores the copy automatically when it was made against
  the current head, and **asks** when the page has been published since —
  restoring silently and publishing would undo the revision in between.
- The header chip opens a review: title/placement changes plus a line diff of
  the source file publishing would write (`buildSource`, now in
  `lib/page-source.ts`), rendered by the same `DiffView` a revision comparison
  uses. It carries **Discard all changes**.
- Leaving in-app no longer asks once the copy is stored. **Cancel** still asks
  (keep and leave / discard / keep editing); the old discard-only prompt and
  the browser's `beforeunload` prompt remain for when storage refused the write.
- A session only removes a copy it wrote or adopted, so closing a clean second
  tab on the same page does not delete the first tab's edits.
- The document page marks its Edit button when a copy is waiting (read after
  mount — the SSR pass has no storage).

Not handled: two tabs *both editing* the same page write the same slot, last
write wins. Copies are per browser, never synced.
