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

- **Info rail toggle** (#698): the rail beside the page (Overview,
  Verification, Revisions, Graph, Comments… and the table of contents) can be
  hidden from ⋯ → View → **Page details**, its twin in the phone aside, or the
  panel button at the end of the title row (from `lg`, above the rail's corner). Hidden, the content takes the full width at
  every breakpoint. It is one per-reader preference for every document page,
  kept in the `kn_pagerail` cookie that SSR reads, so the first frame already
  has the right layout. Until the reader chooses, it follows the role: shown
  for editors and admins, hidden for viewers and guests, who came to read and
  cannot act on most of it. A `?tab=<widget>` link shows a hidden rail for that
  visit and leaves the stored choice alone; widget open state survives a
  hide/show.

## Notes

- Rendering happens client-side only (`onMounted`) — DOMPurify needs a DOM, and
  hydration stays trivial. SSR renders a skeleton.
- `marked` is configured with `gfm: true`; internal links (`/documents/<id>`)
  work because the app is an SPA behind vue-router.

## Future work

- Server-side sanitized rendering for SSR/SEO.
- Attachment/PDF preview once binary revisions land (editor doc, §future).
