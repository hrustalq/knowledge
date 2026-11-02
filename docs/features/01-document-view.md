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

## Linking to a passage

A paragraph, list item, heading, table, code block, quote/panel or `<details>`
can be linked on its own (#708). One grammar everywhere:

```
/documents/<id>?revision=<revisionId>#L<start>-L<end>     (#L<n> for one line)
```

- **Lines** are 1-based lines of the stored body as `GET /v1/documents/:id/content`
  returns it: frontmatter excluded, a leading `# Title` counted even though the
  reader holds it out. `blockLineSpans(md)` in `@knowledge/editor-schema/markdown`
  is the one mapping from a body to its blocks' spans; `markdownToHtml(md, { lineOffset })`
  stamps the same spans as `data-lines`, and the reader's `SourceLines` TipTap
  extension keeps them on the nodes (`linesAt`, `passageBlocks`).
- **Copying.** Hovering a block shows a link control in the gutter beside the
  comment one; a text selection offers *Copy link*, spanning the blocks it starts
  and ends in. Both copy the reference at the revision on screen. A reader who
  cannot comment still gets both. On touch and narrow screens, where the gutter
  is hidden, selection is the path.
- **Opening.** A `#L` hash next to `?revision=` is a pin, not a revision view: the
  page shows the head and highlights the lines. When the head has moved, the
  pinned revision's lines are re-found by quote (`relocateLines` in
  `core/anchor-match.ts`, the same `findAnchor` comment anchors use). When they
  cannot be found the page says the passage changed and links to it *as linked*
  (`&exact=1`, the pinned revision itself). It never highlights a guess. The hash
  is read after mount (the server never sees it), so the server draws revision X
  and the client moves to the head. Without `?revision=` the lines are read
  against whatever revision is shown. Heading anchors (`#some-heading`) are
  unchanged.
- **API and MCP.** `GET /v1/documents/:id/content?lines=40-52` (JSON only) and
  `knowledge_get_document_content({ lines: { start, end } })` return just those
  lines, plus `startLine`, `endLine`, `totalLines` and the `reference` to cite.
  Out of range is a 400.
- **Backlinks.** `[x](/documents/<id>#L3-L5)` is recorded with `L3-L5` as its
  anchor, like a heading anchor (#673).

Not covered: `[S#]` citations opening at the passage (chunks carry no line
spans), passage links on share links, published sites and exports, and git
remote files, which count frontmatter.

## Future work

- Server-side sanitized rendering for SSR/SEO.
- Attachment/PDF preview once binary revisions land (editor doc, §future).
