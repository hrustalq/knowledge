# 37 — AI-readable output: llms.txt, `.md` pages, page AI actions

Tracking issue: [#68](https://github.com/hrustalq/knowledge/issues/68).

## What

Agents increasingly read docs by URL rather than through MCP: a coding agent
fetches a page, a person pastes one into ChatGPT, an IDE indexes an `llms.txt`.
This feature is the plain-HTTP, plain-markdown layer over the versioned store —
private by default, under the same ACL and API-key narrowing as the app.

- **A page as markdown.** `GET /v1/documents/:id/markdown` returns the
  default-branch head as `text/markdown` (`# title` + body). `?frontmatter=1`
  prepends the page YAML with provenance under a `knowledge:` key;
  `?revision=` reads a specific revision. `GET /v1/documents/:id/content` answers
  the same bytes when the request prefers `Accept: text/markdown`, and JSON
  otherwise. `ETag` / `If-None-Match` → `304` without touching S3.
- **llms.txt / llms-full.txt** ([llmstxt.org](https://llmstxt.org)).
  `GET /v1/llms.txt` is a hub: one section per workspace the caller can read.
  `/v1/workspaces/:id/llms.txt` and `/v1/projects/:id/llms.txt` index pages in
  tree order, one `- [title](…/documents/{id}.md): category` line each.
  The matching `llms-full.txt` streams every readable page's text in one
  response — capped, and recorded in the audit log.
- **The web origin serves the same URLs** (`apps/web/server/ai-readable.js`):
  `/documents/<id>.md`, `/documents/<id>` with `Accept: text/markdown` (a
  browser still gets the app), `/llms.txt`, `/workspaces/<id>/llms(-full).txt`
  and `/projects/<id>/llms(-full).txt`. A logged-in tab is authenticated by its
  `kn_token` cookie; an agent sends its API key as a bearer token. Without
  either it gets a plain-text `401` that says where to create a key.
- **Page AI actions menu** (`PageAiActions.vue`, landing in a parallel PR):
  copy as Markdown, view as Markdown, open in ChatGPT / Claude / Cursor, copy
  MCP install config per client, copy agent link. `GET /v1/ai/page-actions`
  (viewer) tells the menu which actions to offer; the builders are the pure
  `apps/web/src/lib/ai-actions.ts`.
- **Admin switch for external actions.** `ai_settings.external_ai_actions`
  (nullable; `null` inherits) turns off "Open in ChatGPT / Claude / Cursor" for a
  workspace. Copy/view as Markdown are never affected.
- **MCP resources.** `knowledge://documents/{documentId}.md` (`text/markdown`),
  `knowledge://workspaces/{workspaceId}/llms.txt` and
  `knowledge://projects/{projectId}/llms.txt` (`text/plain`), as resource
  templates on the existing server.
- **Connect AI** (`/settings/connect`) gets an "llms.txt and markdown" card with
  copyable root / workspace / current-project URLs and a curl example; the
  generated SKILL.md gets a "Plain-markdown access" section with each reachable
  workspace's `llms.txt` URL.

## Decisions

**One predicate decides what is exported.** `ai-readable-scope.ts`
(`readableDocumentsWhere`, `READABLE_REVISION_STATUSES`) is the only definition
of "readable": default-branch heads past `draft`. The page read, both listings,
the full dump and the MCP resources all derive their rows from it, so they cannot
disagree. Publishing will widen it here, and an anonymous route will call the
same builder.

**Authorization is the route's, not the predicate's.** Every scoped route has
`@Access('viewer', …)`, so a cross-tenant or pinned-elsewhere key 403s in
`AclGuard` before content is queried. The hub has no single workspace and runs
`requireRole` per workspace by hand. Each MCP resource handler starts with the
matching `guard.doc` / `guard.ws` / `guard.project` call — the per-tool twin of
`@Access`, pinned by a test that fails if the guard is removed.

**One code path, byte-identical.** REST, web and MCP all call
`AiReadableService`. The web tier is a pass-through proxy — status, bytes, ETag
and cache headers are the API's — and the MCP handlers call the same service
methods the controllers do (without `ifNoneMatch`: MCP has no conditional read).
A test compares the MCP read with the REST response byte for byte.

**Derived at read time, freshness is the ETag.** No stored copy, no
regeneration job. A page's ETag hashes revision id, title, project and the
representation; a listing's hashes every `(id, head, title, category, parent,
position, project)` tuple, so a `304` costs two PG reads and no S3.

**llms-full is streamed and capped, never buffered.** Bodies are fetched in
windows of `AI_READABLE_FETCH_CONCURRENCY` and written in order. The status line
is already sent, so a failed read or a hit cap is an in-band marker, never a
thrown error; a capped workspace dump names the per-project files to use instead.
One audit row per dump.

**No llms-full MCP resource.** One resource read is the wrong unit for a whole
workspace; an agent over MCP has search and per-page reads.

**Authenticated content stays private.** `Cache-Control: private, no-cache`,
`Vary: Accept, Authorization, Cookie`, `X-Robots-Tag: noindex`,
`X-Content-Type-Options: nosniff`.

**Env is a ceiling for external actions.** `AI_EXTERNAL_ACTIONS_ENABLED=false`
turns them off everywhere; a workspace may turn them off under `true`, never on
under `false`. The API reports `requested` / `ceiling` / `effective` / `source`
(`clamped` when the ceiling won) so the settings page shows both. The switch
gates the **offer** only — the actions are client-side links, so there is no
execution step to check.

**Security notes.**

- No credential ever goes into a URL. Every hint, curl example and generated
  snippet uses `Authorization: Bearer $KNOWLEDGE_API_KEY`. The web tier forwards
  an `Authorization` header or the session cookie and **does not forward
  `?token=`** — a credential in a URL leaks into logs and history.
- "Open in ChatGPT / Claude / Cursor" puts page text into a link to that vendor;
  that is why it has an admin switch and an env ceiling, and why pages longer
  than `AI_ACTION_INLINE_MAX_CHARS` are copied to the clipboard instead.
- The agent link is key-free; the agent authenticates with its own key.

## Where it lives

| Piece                                             | File                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Service (page, listings, stream, hub candidates)  | `apps/api/src/ai-readable/ai-readable.service.ts`                   |
| Readable predicate                                | `apps/api/src/ai-readable/ai-readable-scope.ts`                     |
| Page render, ETag, Accept negotiation             | `apps/api/src/ai-readable/render.ts`, `ai-readable.http.ts`         |
| llms.txt / llms-full.txt rendering                | `apps/api/src/ai-readable/llms.ts`                                  |
| Routes                                            | `ai-readable.controller.ts`, `llms-txt.controller.ts`, `DocumentsController` (`/content` negotiation) |
| Module split                                      | `ai-readable-core.module.ts` (both MCP transports, DocumentsModule), `ai-readable.module.ts` (API-only) |
| Web origin proxy                                  | `apps/web/server/ai-readable.js`                                    |
| External actions switch                           | `apps/api/src/ai/external-ai-actions.ts`, `GET /v1/ai/page-actions` |
| Menu builders / menu                              | `apps/web/src/lib/ai-actions.ts`, `PageAiActions.vue`               |
| MCP resources                                     | `apps/api/src/mcp/mcp.service.ts` (`buildServer`)                   |
| Skill section                                     | `apps/api/src/mcp/skill.ts`                                         |
| Connect AI card                                   | `apps/web/src/pages/ConnectAiPage.vue`                              |
| Tests                                             | `apps/api/test/ai-readable.spec.ts`, `external-ai-actions.spec.ts`, `mcp-http.spec.ts`, `apps/web/server/ai-readable.spec.js`, `apps/web/src/lib/ai-actions.spec.ts` |

## Configuration

| Variable                        | Default      | Effect                                                                 |
| ------------------------------- | ------------ | ---------------------------------------------------------------------- |
| `AI_READABLE_ENABLED`           | `true`       | Kill switch: `false` 404s every markdown / llms route and the MCP server stops offering the three resource templates |
| `LLMS_FULL_MAX_DOCS`            | `2000`       | Pages in one `llms-full.txt` before a truncation marker                 |
| `LLMS_FULL_MAX_BYTES`           | `20000000`   | Bytes in one `llms-full.txt` before a truncation marker                 |
| `AI_READABLE_FETCH_CONCURRENCY` | `8`          | Parallel S3 reads while streaming `llms-full.txt`                       |
| `AI_EXTERNAL_ACTIONS_ENABLED`   | `true`       | Ceiling for the per-workspace external AI actions switch                |
| `AI_ACTION_INLINE_MAX_CHARS`    | `6000`       | Longest page put inline into an external-AI link                        |
| `WEB_BASE_URL`, `API_PUBLIC_URL` | —           | Bases of every link in the listings and the skill                       |

## Not done

- **Public access**, sitemap, `robots.txt`, SEO — the Publishing milestone. The
  seam is the scope predicate plus routes that can take `@Public()` behind it.
- **Signed / expiring share links** so a vendor can fetch a private page by URL.
- **A "small" / section-split llms-full variant**; the per-project file covers
  most of the need.
- **LLM-generated summaries** in `llms.txt`; lines carry the category only.
- **Rate limiting** of `llms-full.txt` beyond the caps; none exists in the repo.
- **MCP conditional reads** — resources always return the full text.
