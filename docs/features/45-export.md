# 45 — Export

Issue [#77](https://github.com/hrustalq/knowledge/issues/77), phase 2c of
public publishing. A member takes pages out of the platform as a file: a page,
a page and every page under it, or a whole project, written as

| Format | What is in it | Needs |
| --- | --- | --- |
| `zip` | One markdown source per page, frontmatter included, under `pages/`; every attachment under `attachments/<id>/<name>`; `manifest.json` | nothing |
| `html` | An offline site, zipped: `index.html` (cover + contents), one file per page under `pages/` with breadcrumbs, subpages and previous/next, attachments under `assets/` | nothing |
| `pdf` | One document: cover and contents (for more than one page), a page break per page, diagrams drawn, page numbers in the footer | a Gotenberg sidecar (`GOTENBERG_URL`) |
| `docx` | One Word document: title page and contents (for more than one page), a section per page, Word heading styles, images embedded, diagrams as their source, page numbers in the footer | nothing |

The plan put DOCX on Gotenberg's LibreOffice route, but that route converts
*to* PDF only. The worker writes it itself instead (#162), see
[Word](#word-docx).

## Who can export

Reading is enough: `POST /v1/documents/:id/exports` is `@Access('viewer',
'document')` and `POST /v1/projects/:id/exports` is `@Access('viewer',
'project')`, because an export holds nothing a viewer cannot already read. The
guard resolves the workspace from the page or project id before the handler
runs, so a body never names a workspace.

Seeing an export is narrower. The row says who exported what, so `GET
/v1/exports/:id` and its download answer the requester or a workspace admin,
and 403 anyone else (`ExportService.visible`). `GET /v1/exports` lists the
caller's own exports; an admin's lists the workspace's.

**A share link's reader** can also export, anonymously, when the link allows
download (#161, [43](43-share-links.md#download)). That job belongs to the
link (`share_link_id`), not to a person. Its scope is the link's page, or the
page and its subtree when the link includes it. The requester is
`{ shareLinkId }`, and `ExportScopeService.documents` reads only pages with
nothing restricted on their chain (`OPEN_TO_WORKSPACE`), never what the
link's creator could open. `requested_by` keeps the creator for attribution,
but the job is not in their list and not theirs to download. An admin still
sees it, and only the link's own public routes hand out the file.

When page-level permissions land, the scope must be filtered through their
predicate (`ExportScopeService.documents`). Until then, everything a viewer can
read is exportable.

## The job

`export_jobs` is the request, the progress and the result, and the row is what
the exports page polls. There is no FK on anything, as for `import_jobs`: a
page or project deleted while its export runs must not take the finished file
with it. The title is kept on the row for the same reason.

```
queued → running → completed → expired
                 ↘ failed
```

1. **Asking** (`ExportService`, API and MCP). PDF without `GOTENBERG_URL` is a
   409 `export.formatUnavailable`. The scope is counted first, and more than
   `EXPORT_MAX_PAGES` is a 400 `export.tooManyPages` with `count` and `max`.
   An archived page has nothing to export. Then the row is written and queued
   (`ExportProducer`, BullMQ `export`, `jobId` = row id, one attempt). A queue
   that refuses the job leaves a `failed` row, never a `queued` one forever.
2. **Building** (`ExportBuildService`, worker). The build claims the row with
   a guarded `updateMany`, so a finished or swept export is never rebuilt. It
   resolves the scope again, so pages added since the request are in and the
   page cap is checked a second time. It reads each page's source and
   attachments, renders and converts where the format needs it, writes the
   file to `workspaces/{ws}/exports/{id}/<name>` and completes the row with
   `expires_at = now + EXPORT_TTL_HOURS`. `stage` says what it is doing:
   `collecting | rendering | converting | packaging`.
3. **Done.** `export.completed` / `export.failed` go out with `userId` set to
   the requester, so the live frame reaches them alone. The notification
   fan-out finds them through the run-owner rule (`runOwnerOf`), in the `job`
   category. The inbox row links to `/settings/exports`. A share link's job
   announces nothing: its reader has no inbox and polls, and the link's
   creator did not ask.
4. **Expiry** (`ExportSweeper`, API). A completed export past `expires_at` has
   its object purged, every version of it, since the bucket is versioned. The
   row stays, marked `expired`, as the record of who exported what. A row
   still `queued` or `running` after twice `EXPORT_TIMEOUT_MS` lost its worker
   and is failed with `timedOut`, not requeued: an export is cheap to ask for
   again.

A failure is stored as `{ code, message }`. The code is an `EXPORT_ERROR_CODES`
key the web translates (`tooLarge`, `renderFailed`, `convertFailed`,
`formatUnavailable`, `timedOut`, `failed`); the message is the detail.

## What is exported

The pages a site version of the same scope would publish, in the same order
and with the same file names. `ExportScopeService.documents` reads the scope:
one page, a subtree by `documents.path` (delimited at both ends), or the
project, live pages only. `planSiteBuild` (docs/features/44) then decides the
order, the nesting and the title-derived slug paths, which become the archive
paths. A page left out does not hide its subpages.

**Which revision.** The branch named in the request where a page has it, else
the page's default branch (the site-version rule). Then that branch's head,
unless it is still a draft, in which case the newest revision on it that is
not. Unlike a site, an export does not wait for indexing: a member exports
what a member reads.

**Size.** `EXPORT_MAX_BYTES` caps the attachments before anything is read, and
the finished file after it is built.

## Rendering: the web renders, the worker packages

The markdown parser lives in the web (`core/markdown/render.ts`), and so does
the sanitised server render the public reader uses (`renderPublicMarkdown`).
An export asks it for HTML rather than keeping a second renderer in the API:

- The worker (`ExportRenderClient`) posts the pages, frontmatter stripped,
  to `WEB_INTERNAL_URL` + `/_internal/export/render`, with an `assets` map
  from attachment id to the path its bytes will have.
- The web (`server/export-render.js` → `src/export-render.ts`) answers with
  text files only: `index.html`, page files, scripts, the stylesheet.
- The worker adds the attachment bytes and zips, or uploads everything to
  Gotenberg.

**Who may call the render route.** A peer on the internal network that came
through no proxy (`isDirectInternalCall`). Caddy is an internal peer too, but
it always adds `X-Forwarded-For`, so a request from the internet, which can
only arrive through it, gets a 404. The route reads nothing and holds no
credential: it renders what it is sent, so the check bounds who can spend the
web process's CPU, not who can see data.

**Links.** Each page body goes through `renderPublicMarkdown`, so every link
and asset is rewritten into the export, as for a share:

- A reference to a page in the export becomes a relative file link (HTML), or
  a `#page-<id>` anchor (PDF).
- A reference to a page outside the export keeps its text and loses its link.
- An attachment the export does not carry (`attachmentHref` returns null)
  loses its image, keeps its link text, and keeps its file card's name
  without links.

In a PDF every page shares one document, so heading ids get a per-page prefix
(`idPrefix: 'p<n>-'`). A cross-page link to a heading lands on the start of
that page.

**Styles.** The app's own: `assets/styles/tokens.css` (the palette, moved out of
`assets/style.css` so it can be inlined without Tailwind), `assets/styles/editor.css` (the
read view's stylesheet) and `assets/styles/export.css` (cover, contents, breadcrumbs,
print rules). No web fonts, because an export opens offline and Gotenberg's
Chromium makes no network request.

**Mermaid** is drawn by whatever opens the file, as in the reader. The 3 MB
bundle ships beside the pages only when a page has a diagram. In a PDF the
print script raises `window.__KN_PRINT_READY__` once every diagram is drawn
(or failed, or after 20 s), and Gotenberg waits for it (`waitForExpression`).

## PDF and Gotenberg

`GotenbergClient` posts index.html, `footer.html` (page numbers), the mermaid
bundle when needed, and the **images only** as one flat folder to
`/forms/chromium/convert/html`, at A4 with backgrounds. A PDF cannot link to a
file beside it, so other attachments appear by name. Chromium never needs the
network, and must not have it: a page can embed any URL, and whatever it
fetched would be printed into a PDF the requester downloads. Both compose
files start Gotenberg with `--chromium-allow-list=^file:///tmp/.*`. External
images are therefore missing from a PDF, though they appear in the HTML
bundle, where the reader's own browser fetches them.

Two print details only a real Gotenberg shows. Chromium lays the footer
template out with no width and collapses its whitespace, so the page number
sits in a full-width block (on the body alone it printed as `3/4` at the left
edge). Backgrounds stay on for code blocks and tables, so the print rules
drop the page's off-white tint, which would otherwise print as a panel inside
the margins. Checked against `gotenberg/gotenberg:8`: a 6-page subtree gave
34 A4 sheets with each page starting a new one, and a flowchart and a
sequence diagram were drawn as vectors.

Gotenberg is optional and off in production (about 1 GB). With
`GOTENBERG_URL` empty the dialog shows PDF disabled, with the reason, and the
API refuses it. `make infra-up-gotenberg` runs it on `:3100` in dev.

## Word (DOCX)

`export-docx.ts` writes the file in the worker with the `docx` package. It
walks the tokens of the one markdown parser: `markdownTokens`
(`@knowledge/editor-schema/markdown`) is the same `marked` instance that
`markdownToHtml` renders with, stopped before HTML. The writer parses no
markdown of its own. A callout is a callout to it because `panelOf`, which the
HTML renderer also uses, says so.

**Why the worker, not the web renderer.** HTML and PDF are rendered by the web
because the HTML is the product there. A Word file embeds image bytes, and the
worker already holds them, while the render route answers JSON text files and
never sees an attachment. Writing the file where the bytes are keeps the
route unchanged and the image bytes off the internal network. It also means
DOCX does not need the web up, nor Gotenberg. The parser was already a shared
package (moved for #80), so no token walk had to be lifted.

What each block becomes (pinned by `export-docx.spec.ts`):

| Markdown | Word |
| --- | --- |
| Page title | Heading 1, bookmarked (`kn_p<n>`), at the top of its own section, so a new sheet |
| `#` … `#####` | Heading 2 … 6, one level under the title, so the navigation pane nests a page's sections under it. h1–h3 are bookmarked with the reader's ids, so `#section` links work |
| Lists | Word bullet and numbered lists. Each ordered list gets its own numbering and keeps its `start`. Tasks are `☐`/`☑` lines |
| Tables | A Word table, full width, with a repeating bold header row and the column alignment |
| Code | Style `Code` (Courier New, shaded), one line break per line, indentation kept |
| Callouts (`> [!NOTE]` …) | A label line in the callout's colour, then the body, shaded with a coloured rule on the left |
| Quote | Indented, with a grey rule |
| `<details>` | `▸ summary` in bold over the body, shaded |
| Layout columns, API blocks | Their content flows in order. An API block's heading and tables are ordinary headings and tables |
| Contents macro | The page's headings, linked to their bookmarks |
| Inline marks | Bold, italic, strike, code, `<u>`, `<mark>` (yellow highlight), `<sub>`/`<sup>`; a status lozenge is bold and coloured; mentions keep their text |
| Links | A page in the export becomes an internal link to its title. `#heading` becomes an internal link. `http(s)`/`mailto` stay web links. Anything else, a page outside the export included, keeps its text |
| Images | An attachment of the export is embedded (PNG, JPEG, GIF, BMP), scaled to the page width or to its resized width. A WebP or SVG attachment shows as `[alt]`. A web image stays a link to its address. An attachment the export does not carry is left out, as in the reader |
| File embeds | An image attachment is shown. Anything else is named (`Attachment: name`), because a Word file cannot link to a file beside it |
| Mermaid | Its source in a code block, under "Diagram (mermaid source)" |
| Drawing | A line saying to open the page, since its scene is JSON |

**Diagrams stay source.** Drawing them would mean the mermaid bundle, which
lives in the web, plus a Chromium screenshot per diagram through Gotenberg.
That is a second rendering path for one format, and it would make DOCX depend
on Gotenberg. A deployment that wants drawn diagrams exports PDF.

The labels (contents, page count, callout names) come from the API's
`export.docx.*` catalog in the export's locale. The fonts are Calibri and
Courier New. Both carry Cyrillic, and LibreOffice and Google Docs substitute
metric twins where they lack them.

## The ZIP manifest

`manifest.json` (`ExportManifest`, contracts) is what an import can rebuild a
tree from:

- `format: 'knowledge-export'`, `version: 1`, the scope, root, project,
  branch and title.
- `pages[]` in reading order (parents first). Each page has its
  `documentId`, `parentId` (the nearest exported ancestor), `position`,
  `depth`, `category`, `revisionId`, `branch`, the `path` of its source, and
  its `attachments[]` with their paths.

Feature 16 does not read it yet.

## Surfaces

- **Web.**
  - `ExportDialog.vue` (format, include subpages, branch) opens from the
    page's ⋯ menu (every role), the page tree's row menu (editors, since that
    menu is editor-only; subpages start ticked) and **Export project** on the
    project page.
  - `/settings/exports` (`ExportsPage.vue`) lists exports with stage, size,
    expiry, the error and a Download button. The download is `GET
    /v1/exports/:id/download` → `{ url, filename }`, a presigned URL with
    `Content-Disposition: attachment`, valid for 5 minutes. The page polls
    every 2 s while anything is in flight.
- **REST.** `GET /v1/exports/capabilities?workspaceId=` (formats, limits),
  `GET /v1/exports?workspaceId=`, `POST /v1/documents/:id/exports`
  (`format`, `includeSubtree`, `branch`), `POST /v1/projects/:id/exports`,
  `GET /v1/exports/:id`, `GET /v1/exports/:id/download` (409 `notReady`,
  410 `expired`).
- **MCP.** `knowledge_export` (documentId + includeSubtree, or projectId)
  and `knowledge_get_export` (status, and a download URL once completed).
  Both are read tools, offered to read-only keys.
- **Share reader.** `POST /v1/public/shares/:token/exports` (`format` only),
  `GET …/exports/:id` and `GET …/exports/:id/download` (a 302), behind the
  link's own checks and rate limits. The format choice is
  `ExportFormatPicker.vue`, the same control `ExportDialog.vue` renders.

## Modules

The house split:

- `ExportCoreModule` holds `ExportService` and `ExportScopeService`. It is
  controller-free, and imported by the API, the MCP server and the worker.
- `ExportQueueModule` holds the producer.
- `ExportModule` is API-only: the controller and `ExportSweeper`.
- `ExportWorkerModule` is imported only by `worker.module.ts`: the processor
  (concurrency `EXPORT_CONCURRENCY`), the build service, the render client
  and the Gotenberg client.

The worker builds and completes the row itself: an export creates no page and
attributes no act to anyone but the person who asked.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `GOTENBERG_URL` | `''` | Gotenberg for PDF; empty = no PDF |
| `WEB_INTERNAL_URL` | `http://localhost:5173` | Where the worker reaches the web renderer; `http://web:5173` in prod compose |
| `EXPORT_MAX_PAGES` | `500` | Pages per export, checked when asked and when built |
| `EXPORT_MAX_BYTES` | 256 MB | Attachments before the build, the file after |
| `EXPORT_TTL_HOURS` | `72` | How long a file can be downloaded |
| `EXPORT_CONCURRENCY` | `2` | Builds per worker at once |
| `EXPORT_TIMEOUT_MS` | 10 min | Render + convert ceiling; the sweeper fails a job at twice this |
| `PUBLIC_EXPORTS_PER_HOUR_PER_IP` | `5` | Share-link exports per address and link; fails closed |
| `PUBLIC_EXPORTS_PER_HOUR_PER_LINK` | `30` | Share-link exports per link, every address together; fails closed |

## Not built

- **Diagrams drawn in DOCX**, see [Word](#word-docx).
- **Downloads from a published site.** Only a share link offers one (#161).
- **Exporting an old revision** of a page: an export reads branch heads.
- **Reading a ZIP back in** through import.
