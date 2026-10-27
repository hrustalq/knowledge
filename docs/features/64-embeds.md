# 64 — Embeds: Figma frames in pages, pinned and agent-readable

Issue [#470](https://github.com/hrustalq/knowledge/issues/470), shipped as
nine PRs (#501–#509 and the one carrying this update). Phase 0 decided what is
below; the later phases built it, and where building changed a decision the
section says so. **Built differently** at the end lists every such change.

An analyst who documents UX or UI logic cannot show the design being
described. No surface embeds an external resource. DOMPurify's
`SANITIZE_CONFIG` (`packages/editor-schema/src/markdown.ts`) does not allow
`<iframe>`, the HTML importer deletes it, and the Notion adapter drops `embed`
blocks as unsupported. Mockups therefore end up as pasted screenshots that go
stale without anyone noticing, or as bare Figma links that search, agents,
guests and exports cannot see into.

> **#469 was dropped.** The original plan waited for the editor to move into a
> `@knowledge/editor` package with a read/edit chunk split. #469 closed on
> 2026-10-23 with none of its phases landed, so this milestone builds on the
> current layout. The node view, picker and paste rule live in
> `apps/web/src/components/editor/` and their strings in the web en/ru
> catalogues. The picker is a lazy `import()`.

## What changes

- **One `embed` block** holds an ordered group of up to 24 items. Each item is
  `{ fileKey, nodeId?, version, caption? }`. The group has a caption and a
  layout, `strip` or `grid`. A single frame is a group of one, and one group
  can mix items from different Figma files.
- **A closed provider catalogue** in `@knowledge/contracts`, with Figma as its
  only entry. A URL that matches no provider stays a plain link. It never
  becomes an arbitrary iframe.
- **A `figma` connector** holds a personal access token and an allowlist of
  Figma teams and projects. An empty allowlist means nothing can be embedded.
- **Pinned snapshots.** Each item pins a Figma version. The worker renders a
  PNG at that version. The bytes are content-addressed and shared by every page
  and revision that references them.
- **Every surface renders the block:** the reader, `MarkdownView`, share links
  and published sites (opt-in), and exports. The `.md`, `llms-full.txt` and MCP
  outputs carry it as markup.
- **Agents and search see into it.** Frame names, captions and text layers are
  indexed. `knowledge_get_embed` and `knowledge_find_embeds` serve the group
  and the reverse lookup.
- **The connector notices design changes** on a fixed tick. The reader shows a
  badge and editors get an **Update** action. Nothing changes a page by itself.

## The block in markdown

Markdown stays canonical, and text stays visible
([rich-editor contract](03-editor.md)). The block is raw HTML that any
markdown renderer shows as captioned links:

```html
<figure data-kn-embed="strip">
<a href="https://www.figma.com/design/AbC123/?node-id=12-34" data-kn-version="2083951442">Sign-in, empty</a>
<a href="https://www.figma.com/design/AbC123/?node-id=12-80" data-kn-version="2083951442">Sign-in, error</a>
<a href="https://www.figma.com/board/XyZ789/" data-kn-version="2079113001">Flow board</a>
<figcaption>Sign-in flow</figcaption>
</figure>
```

- **`data-kn-embed` carries the layout** (`strip` | `grid`). The issue spelled
  it `data-kn-layout`, but that attribute already marks the column layout
  block. CSS, turndown and the parse rules all select on it, so reusing it
  would make every embed match two blocks.
- **Each item is one `<a>`** with the canonical URL and the pinned
  `data-kn-version`. The link text is the item's caption. With no caption, the
  text is the canonical URL, so the link is never empty.
- **No blank line inside the figure.** CommonMark ends an HTML block at the
  first blank line, so the whole group must stay one HTML block. The serializer
  writes it that way. The parser accepts the items in any whitespace as long as
  they stay inside one block.
- **References only.** The markdown never holds an image URL. A snapshot is
  addressed by its key and served by a route that checks access on every read
  (below).
- **The canonical URL** is `https://www.figma.com/design/{fileKey}/` for design,
  prototype (`/proto/`), Dev Mode and legacy `/file/` links. FigJam boards use
  `/board/{fileKey}/`. `?node-id=` is present when the item is a node, written
  in the URL's dash form (`12-34`) and stored in the API's colon form (`12:34`).
  A branch URL's branch key is the file key, because that is the key Figma's
  API takes. Title slugs and every other query parameter are dropped, so two
  links to the same node canonicalize to the same string.
- **Versions are pinned per item.** Updating to the latest design rewrites one
  `data-kn-version`, which makes an ordinary new revision whose diff is that
  attribute. This also keeps per-branch content dedupe correct: without the
  version in the markdown, a refreshed snapshot would be byte-identical content.
- **An unpinned item** (no `data-kn-version`, from a hand-written or agent
  write) is kept and rendered as a plain link. The revision gets a warning, and
  the editor's **Update** action pins it. The worker never edits markdown to pin
  it, because that would be a revision nobody wrote.

`KN.embed` and `KN.version` join the vocabulary in
`packages/editor-schema/src/nodes.ts`. The node spec (`index.ts`), the parse
rule (`markdown.ts`), the sanitizer allowlist and the turndown rule
(`serialize.ts`) change together. Adding the node changes `SCHEMA_VERSION`,
which shared drafts already detect ([56](56-realtime-coediting.md)).

## The provider catalogue

`@knowledge/contracts/embeds` holds `EMBED_PROVIDERS`, a closed list with one
entry, `figma`. Each entry has a URL matcher, a canonicalizer to and from
`{ fileKey, nodeId, kind }`, and what the worker does for it (snapshot and
index). The editor's paste rule, the parse rule, the importers, the connectors
and the API's warnings all call one function, `parseEmbedUrl(url)`. A URL it
refuses stays a link everywhere.

Accepted Figma URLs:

- `/design/`, `/file/`, `/proto/` and `/board/`;
- the `www.` and bare hosts;
- a Dev Mode `m=dev` parameter, which is dropped;
- a branch path, `/design/{key}/branch/{branchKey}/`.

Any other host, `figma.com/community/…`, and a link with no file key are
refused.

## The Figma connector

- **A new kind.** `figma` joins `CONNECTOR_KINDS` with
  `{ pull: false, push: false, webhook: false, tree: false, embeds: true }`. It
  moves no content. The `embeds` capability is optional, for the reason `tasks`
  and `harvest` are. Its "sync" is the change check. It never creates a page.
- **The credential** is a Figma personal access token in the encrypted
  `Connector.credential` (`ai/secret-box.ts`, write-only over the API). It is
  read through `ConnectorsService.credentialFor`, like every other connector's.
  It needs three scopes, and its owner must be able to open every allowlisted
  team and folder:

  | Scope                | For                                                                                   |
  | -------------------- | ------------------------------------------------------------------------------------- |
  | `folders:read`       | `GET /v2/teams/:id/folders`, `GET /v2/folders/:id/folders`, `GET /v2/folders/:id/files` |
  | `file_content:read`  | `GET /v1/files/:key`, `/v1/files/:key/nodes`, `/v1/images/:key`                       |
  | `file_metadata:read` | `GET /v1/files/:key/meta`                                                             |

  Figma renamed projects to folders and deprecated `projects:read` with the
  `/v1` project endpoints; a token issued with `folders:read` cannot call
  them, so the listing uses only the `/v2` folder endpoints (#549).

  Test connection also asks `GET /v1/me` for the owner's handle. That needs
  `current_user:read`, which embedding never does, so a `403` there only drops
  the handle (#545).
- **Token expiry is a config field**, typed in by the admin. Figma's API does
  not report a PAT's expiry, so the card shows the date the admin entered. From
  14 days before it, the card warns. A bad token is a `401`. A `403` on a
  listing is a missing `folders:read` or an entry the owner cannot open, and
  Test connection names that entry (`team:<id>` / `project:<id>`) along with
  Figma's own `err` text, which is what tells those two apart; it is never
  read as expiry.
- **The allowlist** is one config field holding Figma team and folder URLs or
  ids (`team:<id>`, `folder:<id>`). A folder is what Figma used to call a
  project, with the same id, so `project:<id>` and `/files/project/<id>` links
  read as folders too. Figma's file metadata does not name a file's folder, so
  membership is resolved by listing:
  - `GET /v2/teams/:id/folders` expands a team into its top-level folders;
  - `GET /v2/folders/:id/folders` lists a folder's subfolders, walked
    recursively with a visited set (folders nest, and a team listing stops at
    the top level);
  - `GET /v2/folders/:id/files` lists each folder's files.
  - The result goes into a mutable `embed_files` row: `fileKey`, `projectId`,
    `teamId`, `name` and `connectorId`. `projectId` is the folder the
    allowlist reached the file through (the allowlisted folder, or the team's
    top-level one), not the subfolder it sits in, so `embedFileAllowed`
    answers from the allowlist alone.
- **The check runs three times:** when an item is added (the picker and the
  API's warning pass), when the worker snapshots, and **on every snapshot
  read**. The read check is a PG lookup: the file's row, its connector enabled,
  and its project or team still in that connector's allowlist. Removing a
  project or disabling the connector stops its snapshots rendering everywhere,
  including in old revisions, and the items fall back to caption + link. Adding
  it back restores them, because the bytes never left storage.
- **One HTTP client.** Every Figma call goes through `connectorFetch` over
  `common/safe-url.ts`. On `429` it backs off by `Retry-After`, capped, before
  giving up for this tick. The browser never holds the token, because the
  picker's calls go through the API.

## Snapshots

- **When.** After finalize, a worker job runs for each item the revision
  references. An item already in the cache costs nothing.
- **What it renders.**
  - It reads the node at the pinned version (`GET /v1/files/:key/nodes?ids=…&version=…`)
    for the frame name, the text layers and a subtree hash.
  - It renders the PNG (`GET /v1/images/:key?ids=…&version=…&format=png`) at 2×
    scale, reduced so the long side stays within 4096 px.
  - It stores the PNG under
    `workspaces/{ws}/embeds/figma/{fileKey}/{nodeId}/{version}.png`.
  - A file-level item renders the file's thumbnail. That is the one snapshot
    not pinned to a version, and the item says so.
- **The cache.** `embed_nodes`, keyed by
  `(workspace, provider, fileKey, nodeId, version)`, holds the frame name, the
  extracted text, the subtree hash, the snapshot key and the size. It is
  immutable, because a pinned version never changes. A failed render is a row
  with an error and a retry time, not a missing row, so the tick can retry it.
- **What a revision references.** `revision_embeds` gets one row per item,
  written at finalize: group index, position, item, caption and a nullable
  `warning` (not allowlisted, unpinned, malformed, over the item limit). This
  is how "the revision gets a warning" without a new column on
  `document_revisions`.
- **The routes.**
  - `GET /v1/documents/:id/embeds` (`viewer`, `document`) answers each
    referenced item's state — `ready`, `rendering`, `unavailable`, `failed` —
    with its name, size and `changed`, and queues a render for what is missing.
    The node view reads it once per page and polls while something renders.
  - `GET /v1/documents/:id/embeds/:fileKey/:nodeId/:version` (`viewer`,
    `document`, `@CookieTokenOk`, mirroring `attachments.controller.ts`)
    answers with a 302 to a presigned URL, but only when a revision of **that
    document** references the item, the item passes the allowlist read check,
    and the cache has the bytes. Otherwise 404. A file-level item uses `_` as
    its node segment.
- **Figma being down never fails indexing.** Indexing reads the cache and never
  calls Figma. A miss leaves the item as caption + link, and the connector tick
  fills the cache later.

## Every surface

| Surface | Shows |
| --- | --- |
| Reader (read-only `RichEditor`) and `MarkdownView` | The snapshot, the captions, and "Open live" for members only. "Open live" mounts Figma's embed iframe inside the node view, never through sanitized HTML. |
| Editor | Same, plus caption editing, reorder, layout, remove, Update. |
| Share links ([43](43-share-links.md)) and published sites ([44](44-docs-portal.md)) | Snapshots only when **Publishing → Show embedded designs publicly** (`publishing_settings.allow_public_embeds`) is on, default off. The page's markup is rewritten **on the server** (`EmbedsService.publicMarkdown` over `rewriteEmbedGroups`), so no Figma link reaches the reader's browser at all: off, each item is its caption; on, a ready allowlisted item carries an opaque `data-kn-item` (its `revision_embeds` id), which `…/public/shares/:token/embeds/:itemId` or `…/public/sites/:siteId/versions/:versionId/embeds/:itemId` resolve after the link's scope or the site's pinned revision and audience. Never the live iframe. |
| A published site's `.md` and `llms-full.txt` | Captions only, whatever the switch. |
| Export ([45](45-export.md)) html, pdf, docx | A member's export always shows the snapshots, packaged as image attachments keyed by item id; a share link's export follows the switch. The zip keeps the source. |
| `.md`, `llms-full.txt`, `knowledge_get_document_content` behind the login | The `<figure>` markup as stored. It is parseable, and it carries no image URL. |

## Agents and search

- **`knowledge_get_embed({ documentId, group? })`** (`guard.doc(…, 'viewer')`)
  returns one group:
  - its canonical node URLs and captions;
  - the extracted text, wrapped untrusted;
  - the snapshot images as MCP image content.

  A coding agent passes the node URLs to Figma's own Dev Mode MCP for layers
  and CSS. We do not re-serve Figma's node tree.
- **`knowledge_find_embeds({ figmaUrl | fileKey })`** (`guard.ws(…, 'viewer')`)
  returns the pages whose **head** revisions embed that file or node, with the
  captions and the section heading around each group. The results are filtered
  by the caller's `AccessScope` in PG. It has a REST twin
  (`GET /v1/embeds/usages`). It is a read tool: it stays out of `WRITE_TOOLS`.
- **Indexing** covers the file name, frame names, captions, and the text layers
  of the selected nodes. The text is deduplicated, capped at 2 KB per item, and
  put in **its own chunks** after the page's prose, so it cannot drown out what
  the page says. Like all document content, it is wrapped untrusted wherever it
  reaches a prompt.

## Writing and editing

- `/figma` (also `/макет`) opens the picker, a lazy `import()` so a reader
  never downloads it. It lists the allowlisted files, each page's top-level
  frames with thumbnails, and takes a pasted link for a deeper layer; the
  selection reorders by drag or arrow buttons, with a caption per item, a group
  caption, and Strip or Grid. Every Figma call goes through the API
  (`/v1/embeds/figma/files`, `/files/:fileKey`, `/resolve`, editor role).
- A Figma link pasted alone on an empty line becomes a one-item group, pinned
  through `/resolve` and captioned with the frame's name; a 10 s toast offers
  **Keep as link**, and undo works too.
- The pencil on a group reopens the picker. **Update** on a changed or unpinned
  item pins it to the file's current version as an ordinary edit.

## Writes that skip the picker

- **MCP, REST, imports and collab** can all write an item that is not
  allowlisted, is malformed, or is over the item limit. Such an item is kept in
  the markdown, rendered as a plain link, and recorded as a `revision_embeds`
  warning. It is never rejected: a write path that refuses a whole page over
  one link is worse than one bad link.
- **Pull conversion**, version pinned at pull time:
  - Notion `embed` blocks with a Figma URL;
  - Confluence Cloud and Server Figma macros and Figma iframes;
  - Figma iframes in the HTML importer, converted before it strips iframes;
  - a lone Figma URL on its own line in `markdown-git`.
- **Push** writes each item back as the target's native Figma embed, with the
  group caption as a paragraph. The layout is lost.

## When the design changes

- **The change check is the `figma` connector's sync.** It runs on the existing
  schedule sweeper's fixed tick, by default every 6 h, with no second run while
  one is in flight. There is no cron.
- **It compares subtrees, not files.** For each distinct item that a head
  revision pins, it reads the node at the file's current version and compares a
  hash of that node's subtree with the pinned hash. Edits elsewhere in the file
  do not count. The current hash goes in a mutable `embed_node_heads` row.
- **The state is derived on read:**
  - "Design changed in Figma since this was pinned" on the item;
  - an **Update** action for editors, which rewrites `data-kn-version` through
    an ordinary edit;
  - a `stale-mockups` entry in `HEALTH_FILTERS`, filtered in SQL like every
    other health filter.
- **Nothing flags a page, and nothing opens a merge request.**

## Built differently

Where building changed a phase 0 decision:

- **The public switch lives on `publishing_settings`** (`allowPublicEmbeds`),
  beside the other public switches and their settings page, not on
  `workspace_settings`.
- **Public pages are rewritten on the server**, not only in the renderer: the
  share and site page payloads carried the raw `<figure>`, so its Figma links
  reached the anonymous browser. Snapshots on a public page are addressed by an
  opaque item id, never by file key.
- **A share link's export follows the public switch.** The issue said export
  always shows snapshots; that holds for a member's export, but a share link's
  download is anonymous, and including them would bypass the switch.
- **The snapshot route has a status twin** instead of answering 202:
  `GET /v1/documents/:id/embeds` reports every item's state at once, and the
  node view polls it.
- **Indexed frame text follows the allowlist at index time.** Revoking a
  project hides its snapshots at once; its text leaves the index at the page's
  next reindex.
- **`FigmaFilesService` lives in `ConnectorsCoreModule`**, so the connector
  staging step can pin pulled embeds; the allowlist rule is the leaf
  `embeds/embed-access.ts`.
- **The importer does not pin.** A Figma iframe in an imported HTML page
  arrives unpinned and warns until an editor presses Update; connector pulls
  pin.
- **A frame deleted in Figma reads as changed.** Whole-file items have no
  subtree and are not checked.

## Invariants

1. The markdown holds references, never image URLs.
2. Sanitized HTML never allows `<iframe>`. The live frame is mounted by the node
   view, for members only.
3. A snapshot is served only when a revision of the requested document
   references it, **and** the allowlist passes **at read time**.
4. Revoking access (an allowlist entry, the connector) hides the snapshots and
   deletes nothing. Restoring it restores them.
5. Indexing never calls Figma. The cache is the only input.
6. No write path rejects a page over an embed. It warns.
7. Public surfaces show no Figma link unless `publicEmbeds` is on.

## Knobs

Each env var has a default, as `generate-openapi.main.ts` requires.

| Env | Default | What it bounds |
| --- | --- | --- |
| `EMBED_MAX_ITEMS` | `24` | Items per group. Extra items stay links, with a warning. |
| `EMBED_SNAPSHOT_SCALE` | `2` | Figma render scale. |
| `EMBED_SNAPSHOT_MAX_PX` | `4096` | Long side of a snapshot. |
| `EMBED_TEXT_MAX_BYTES` | `2048` | Extracted text per item. |
| `EMBED_CHECK_INTERVAL_HOURS` | `6` | Hours between a Figma connector's change checks. |

`allowPublicEmbeds` is a sparse `publishing_settings` column. `null` and
`false` both mean off.

## Phases

One PR per phase into `dev`. Each phase leaves the app working.

| # | Phase | PR |
| --- | --- | --- |
| 0 | Decision doc | #501 |
| 1 | Block and markdown | #502 |
| 2 | Connector | #503 |
| 3 | Snapshots | #504 |
| 4 | Editor UX | #505 |
| 5 | Index and agents | #506 |
| 6 | Public surfaces and export | #507 |
| 7 | Conversion | #508 |
| 8 | Change check | #509 |
| 9 | Docs | this one |

## Out of scope

- Providers other than Figma. The catalogue is built to take them, and each is
  its own issue.
- Numbered callouts or pins on a frame.
- A vision-model description of snapshots.
- Figma OAuth, per-user Figma accounts, and Figma webhooks.
- An automatic merge request that bumps versions.
- Re-serving Figma node trees or CSS.
