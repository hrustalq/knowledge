# 16 — Document import

Replaces the legacy `/upload` page: a textarea you pasted markdown into, on the
one route whose entire job is "get an existing document into the knowledge
base". It could not accept a document.

Import is now a three-step flow — **Destination · Parse · Review** — that takes
a real file, parses it with the parser its format deserves, and lets a person
read and correct the result before anything is created. The original file stays
attached to the page it becomes.

## Flow

```
POST /v1/imports          reserve a row + presigned PUT   (type & size refused here)
PUT  <presigned>          bytes go straight to MinIO      (never through Node)
POST /v1/imports/:id/start   HEAD confirms arrival → BullMQ
     …worker parses, writing `stage`/`progress` to the row the client polls…
GET  /v1/imports/:id         status, stage, warnings, meta
GET  /v1/imports/:id/content the parsed markdown, read once
POST /v1/imports/:id/submit  create the page, attach the original, index it
DELETE /v1/imports/:id       discard, and delete the staged files
```

Parsing is a **worker job, not a request**: a 300-page PDF outlasts any sensible
HTTP timeout, and the person who started it may close the tab. The row is the
truth, the queue is the scheduler, the wizard is a view of the row — so leaving
and coming back rejoins the same parse (`kn_import_active` in sessionStorage).

## Why a new table

`ingestion_jobs.revision_id` is NOT NULL, and an import exists *before* any
document does — that is the whole point. `import_jobs` is its own table.

The parsed markdown is **not** stored in that row: it goes to
`workspaces/{ws}/imports/{id}/parsed.md` beside the original, keeping the
three-store split honest (PG = transactional truth, MinIO = bytes) and keeping
the row the wizard polls every second small.

## Parsers

`apps/api/src/import/parsers/`, one interface, routed by `importFormatFor` in
`packages/contracts` — the same function the drop zone, the reserve guard and the
registry all call, so a file the picker accepts can never be one the worker has
no parser for.

| Parser | How | Notes |
|---|---|---|
| `pdf` | `unpdf` (pdfjs) | A PDF has no headings, only glyphs at sizes — so structure is *reconstructed*: lines regrouped, body size taken as the size most characters are set in, the few larger sizes ranked into h1–h3. Repeating running heads and page numbers are dropped by repetition. Paragraph breaks come from vertical gaps against the median line spacing. Near-empty text sets `meta.needsOcr`. |
| `docx` | `mammoth` → HTML → `turndown` | Word's own *styles* map to semantics, so a "Heading 2" is `##` and not a bold paragraph. Images are lifted out (never inlined as data URIs — that would bloat every revision and defeat dedupe). Glyph bullets (`• item`, common in round-tripped files) are turned back into lists. mammoth's own warnings are surfaced verbatim. |
| `pptx` | `fflate` + slide XML | One `##` per slide, bullets nested by real outline level, pictures resolved through each slide's rels, speaker notes kept as quotes. |
| `html` | `turndown` | `head`/`title`/nav/footer/script/style removed. Remote images stay remote, and are reported. |
| `tabular` | ~40 lines, quote-aware | CSV/TSV → a GFM table. |
| `structured` | `js-yaml` | Small objects become one `##` per top-level key; anything large or array-shaped stays one fenced block. |
| `plaintext` | — | Markdown passes through untouched (frontmatter kept, so relations still index). Plain text gets hard wraps rejoined. |
| `ocr` | workspace vision model | Routed through `AiConfigService.resolveFor(ws, 'review')`, billed to `ai_usage` as `operation: 'import'`. Asked to **transcribe, never summarise**. No provider → an instruction, not a stack trace. |

`stripLeadingTitle` removes the body's opening heading when it merely repeats
the detected title, so an imported page does not say its own name twice.

## Warnings are the point

Every parser returns what it could **not** carry, and the review step shows it
beside the text. A lossy import that says nothing is the failure this flow
exists to prevent: dropped images, "no headings were found, so the whole file
became one section", "this looks like a scanned PDF", `N` unsupported Word
styles, truncated rows.

## Submit

One server-side call, not four client ones. It creates the document **without**
inline content (a draft revision), promotes the original and any extracted
images into `attachments`, rewrites the staged `/v1/imports/:id/images/N` links
to their new attachment URLs, then writes the markdown once and finalizes — so
the page has exactly one revision whose image links have always worked, rather
than a first revision full of dead links and a second one fixing them.

## Module split

The house rule, applied twice:

- `ImportQueueModule` — producer, imported by **both** API and worker.
- `ImportModule` — controller + service, **API only** (`AppModule`).
- `ImportWorkerModule` — processor + `ParsersModule`, **worker only**
  (`worker.module.ts`). Importing it into `AppModule` would make the API start
  consuming parse jobs.

ACLs use a new `'import'` `WorkspaceSource`: `:id` → owning workspace, resolved
in Postgres before the handler runs. It is the only thing standing between one
tenant's import id and another tenant's staged file.

## Web

`/upload` (aliased `/import`) is `meta.fill`: the wizard owns the viewport. A
fixed header carries the title and stepper, the body flexes, and **one action
bar** sits at the bottom on every step — the three steps differ enormously in
height, and without a fixed frame the primary action would wander down the page.

- **Step 1** — the file is the decision, so the drop zone takes the room
  (clamped 18–34rem); the destination is confirmation and sits in a rail at the
  same width every other rail in the product uses.
- **Step 2** — one ring, two honest behaviours: it *fills* while the browser
  uploads (real bytes, via XHR — `fetch` still cannot report upload progress)
  and *sweeps* while the worker parses, because at that point the client
  genuinely does not know. The handoff between them is the surface's authored
  moment. The label is the worker's own account of what it is doing.
- **Step 3** — deliberately the same shell as `/documents/:id/edit`: the title
  in `RichEditor`'s lede slot, the prose column scrolling itself, a rail beside
  it for provenance, warnings and destination. Correcting a heading the parser
  guessed wrong is the same gesture here as it will be on the page tomorrow.

Motion elsewhere is feedback only: the drop zone answers a file carried over it,
the chosen file arrives rather than snapping, the stepper's rule fills as you
advance, extra warnings expand instead of jumping. Every one has a
`prefers-reduced-motion` path that reduces movement without erasing the signal.

Step entrances are **keyframe animations, not `-enter-from` classes**: removing
that class needs an animation frame, and a tab backgrounded mid-transition never
gets one — which would strand a step invisible inside a frame that still shows.
The resting state is visible; the animation is the enhancement.

## Env

```
IMPORT_MAX_BYTES=52428800     # 50 MB, enforced at presign and again from the bucket's HEAD
IMPORT_PARSE_TIMEOUT_MS=120000
IMPORT_OCR_MAX_PAGES=20
```

## Not in scope

Batch multi-file import; an MCP `knowledge_import` tool; EPUB/RTF/XLSX; PDF
embedded-image extraction (reported as a warning); re-parsing an existing page
with a better parser later.
