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
