# 01 — Full document view

> Оригинал: «Просмотр документа (полный)»

## What it is

Render the full markdown body of a document's head (or any given) revision in
the web app, instead of only chunk snippets.

## Design

The API never streamed file bodies before (clients upload via presigned PUT).
Reading is different: the rendered view needs the raw markdown, and proxying a
single text object through the API keeps the browser out of MinIO-credential
territory. So:

- **API**: `GET /v1/documents/:id/content?revision=<revisionId>` →
  `DocumentContentResponse { documentId, revisionId, contentType, frontmatter, markdown }`.
  Implemented in `DocumentsService.getContent`: resolve the revision exactly
  like `getDocument` (head of the default branch when `revision` is omitted),
  fetch bytes with `StorageService.getObjectText`, split frontmatter with
  `gray-matter`. Draft revisions 409 — there is nothing uploaded yet or the
  content is not final.
- **Web**: `MarkdownView.vue` renders markdown client-side with `marked`,
  sanitized with `dompurify`, and lazily renders ` ```mermaid ` fences with
  `mermaid` (dynamic import, only when a diagram is present). The document
  detail page gains a **Content** tab that shows the rendered body plus the
  frontmatter block.

## Notes

- Rendering happens client-side only (`onMounted`) — DOMPurify needs a DOM, and
  hydration stays trivial. SSR renders a skeleton.
- `marked` is configured with `gfm: true`; internal links (`/documents/<id>`)
  work because the app is an SPA behind vue-router.

## Future work

- Server-side sanitized rendering for SSR/SEO.
- Attachment/PDF preview once binary revisions land (editor doc, §future).
