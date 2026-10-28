# 43 — Share links

Issue [#77](https://github.com/hrustalq/knowledge/issues/77), phase 1 of
public publishing. An editor hands one page (and optionally the pages under
it) to someone who will never sign in: a customer, a contractor, a reviewer
from another team. The link opens a read-only, server-rendered copy of the
page. Published docs sites and versions are phase 2a
([44](44-docs-portal.md)); custom domains and export are later phases of the
same issue. Downloading a link's pages is [#161](https://github.com/hrustalq/knowledge/issues/161)
(see [Download](#download) below).

## Public is opt-in twice

Nothing is public until two switches allow it:

1. **The deployment.** `PUBLIC_SHARING_ENABLED` (default `true`) is a ceiling.
   With it off, no link can be created and every existing link answers 404,
   whatever the workspace says.
2. **The workspace.** `publishing_settings` is a sparse override of a code
   default that is **off**: an empty table is exactly "nothing is public". An
   admin turns sharing on in **Settings → Publishing**. The page shows what is
   asked for beside what applies, and says so when the env ceiling is off.

A second workspace switch, `allowPasswordlessShares` (also off by default),
decides whether a link may have **neither** a password nor an expiry.
`shareNeedsPassword` (contracts) is the one predicate the popover, the API and
the MCP tool all use. `SHARE_LINK_MAX_TTL_DAYS` caps every link's lifetime. A
"never" link under a cap becomes the cap, and the create response returns the
expiry that was asked for when the cap moved it.

## The link

`ShareLink` (`share_links`) points at one document, with `include_subtree`,
`allow_download` (default `false`), `expires_at`, an optional scrypt
`password_hash` and `revoked_at`.

- **Token.** `kp_` + 32 random bytes, base64url. The database looks a link up
  by `token_hash` (SHA-256) only. `token_cipher` holds the same token under the
  secret box (`ai/secret-box.ts`, `SETTINGS_ENCRYPTION_KEY`), so an editor can
  copy the link again later. Without a key the column is null and the link is
  shown once, at creation; the UI says so.
- **Revoke** sets `revoked_at` and keeps the row, so the admin inventory still
  lists it. It is a single guarded `updateMany`, so a second revoke records
  nothing.
- **Deleting a project** deletes its pages' links in `ProjectCascadeService`.
  A link to a page that is gone must stop resolving, and the FK would refuse
  the delete anyway.

## The anonymous read

`PublicSharesController` (`/v1/public/shares`, `@Public()`) resolves the link
afresh on **every** request, with no cached authorisation, so a revoke, an
expiry or a switch turned off takes effect on the next request:

| Route | Answers |
| --- | --- |
| `GET :token` | `{ locked: true }`, or the title and the tree the link reaches |
| `POST :token/unlock` | 204 + an httpOnly `kn_share_<id>` cookie; 401 wrong password; 429 too many tries |
| `GET :token/pages/:documentId` | title, markdown body (frontmatter stripped), `updatedAt` |
| `GET :token/attachments/:attachmentId` | 302 to a presigned URL |
| `POST :token/exports` | queue an export of the link's scope; 404 with download off; 429 over the limit |
| `GET :token/exports/:exportId` | the job, polled while it runs (`PublicShareExport`) |
| `GET :token/exports/:exportId/download` | 302 to a presigned URL of the finished file |

**Scope.** A page is in scope if it is the shared page, or, with
`include_subtree`, if its `documents.path` starts with the root's path, it is
in the same workspace, and it is not archived. An attachment is in scope if its
page is. Anything else is a **404, the same answer as a link that does not
exist**: an unknown, revoked or expired token, an archived root, or a workspace
with sharing off. The body comes from `DocumentsService.getContent()`, so there
is no second content path. The response shapes (`PublicShareResponse`,
`PublicSharePage`) are their own contracts types and carry no authors,
revision ids, comments or history.

**Headers.** Every share response, errors included, carries
`Referrer-Policy: no-referrer` (the token is in the URL),
`X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`. The web
server sets the same three headers on the HTML.

**Password sessions.** An unlock writes a random session value to Redis for
`SHARE_UNLOCK_TTL_MIN`, mapped to `shareId|fingerprint(password_hash)`. The
check compares against the link's current hash, so changing or clearing the
password ends every open session at once. Sessions live server-side rather
than in a signed cookie because `SETTINGS_ENCRYPTION_KEY` is optional and there
is no other signing secret to rely on.

**Rate limits.** `PublicRateLimiter` keeps fixed-window counters in Redis
(`INCR` + `PEXPIRE`). It is in-house rather than `@nestjs/throttler`, because
two commands a request need no dependency.

- Every public read: `PUBLIC_RATE_LIMIT_PER_MIN` per IP. This fails open: a
  Redis outage keeps reads up.
- Password attempts: `PUBLIC_UNLOCK_ATTEMPTS_PER_15MIN` per IP and link,
  counted before the password is compared. This fails closed: a Redis outage
  must not mean unlimited guesses.
- Exports: `PUBLIC_EXPORTS_PER_HOUR_PER_IP` per IP and link, and
  `PUBLIC_EXPORTS_PER_HOUR_PER_LINK` per link across every address, counted
  before the scope is read. This fails closed, so a public link cannot keep
  Gotenberg busy while the counter is down. Polling and downloading count only
  against the per-IP read limit.

## Download

With `allow_download` on, a reader can take the link's pages away as ZIP, HTML
or PDF ([45](45-export.md)) without signing in (#161).

- **The offer.** `GET :token` carries `download: { formats, ttlHours }`, or
  `null` with download off. `formats` is the deployment's
  (`ExportService.capabilities`), so PDF is offered only with `GOTENBERG_URL`.
  The reader shows it disabled otherwise.
- **The scope is the link's.** `ExportService.createForShareLink` asks for
  scope `page`, or `subtree` when the link has `include_subtree`, rooted at
  the link's page, on default branches. The DTO takes a format and nothing
  else, so a reader cannot widen it. `ExportScopeService.documents` reads it
  with the requester `{ shareLinkId }`, both when the job is asked for and
  when the worker runs it. That requester sees `OPEN_TO_WORKSPACE`, nothing
  restricted on the chain, which is the rule the share tree uses. It never
  sees what the link's creator could open, and never a project.
- **The job belongs to the link.** `export_jobs.share_link_id` names the link,
  with no FK (house policy). `requested_by` is the link's creator, kept for
  attribution only: the job is not in the creator's own export list and not
  theirs to download, though a workspace admin still sees it on **Exports**.
  An anonymous reader has no inbox, so the worker publishes no
  `export.completed` / `export.failed` for these jobs, and the reader polls.
- **Every call resolves the link again.** Creating, polling and downloading
  each need the link live, unlocked (a locked link answers 401 until the
  password cookie is set) and with download on. A job from another link, or a
  member's own job, is a 404, and so is a subtree export once the link no
  longer includes the subtree. So revoking the link, letting it expire,
  switching download off or narrowing the link stops even a finished file
  from downloading on the next request. The file itself is removed by the export sweeper at
  `EXPORT_TTL_HOURS`, as every export's is.
- **The reader's shape.** `PublicShareExport` carries the format, status,
  stage, page count, size, error and times. It has no workspace, page or
  person id.

`clientIp` trusts `X-Forwarded-For` only from an internal peer. Caddy and the
web SSR are the only things that reach the API, and both are internal. In
production Caddy writes that header from the PROXY protocol header the home
router's HAProxy adds, because Colima's port forwarder hides the visitor's
address from Caddy (#587).

## The public reader (web)

`/s/:token[/:documentId]` is a **separate SSR entry** (`src/entry-public.ts`)
with its own shell (`reader.html`), client entry and app (`public-main.ts`):
one page component, no router, no Pinia, no query client, no auth guard. Vite
builds it beside the member app (`rolldownOptions.input`), so a reader
downloads none of the app shell. It also has its own small catalog
(`src/i18n/reader/{en,ru}.json`): a JSON module shared with the app would carry
both whole app catalogs into the reader's bundle. That one import was 377 KB.

- **What `server.js` passes on.** `server.js` matches the path before it reads
  any cookie. It hands the render only the language, the `kn_share_*` cookies
  and the visitor's `X-Forwarded-For`, never `kn_token`. A signed-in member who
  opens a link is anonymous there too.
- **The body renders on the server.** `MarkdownView` renders nothing during SSR
  (DOMPurify needs a DOM), which is fine behind a login and useless for a cold
  link. `lib/markdown/public-render.server.ts` runs the same `markdownToHtml`
  and `SANITIZE_CONFIG` against a jsdom window, the DOM DOMPurify officially
  supports. It then does MarkdownView's passes: heading ids, table wrappers,
  file cards, drawings and the TOC block.
- **Links and assets are rewritten into the share's scope.** A reference to a
  page the link reaches becomes a reader URL. Any other `/documents/<id>` keeps
  its text and loses its target, as does every other same-origin path, since
  nothing behind the login is reachable. Attachments go through the public
  attachment route, and member-only images (avatars) are dropped. Page-title
  references and glossary linking are off: both need the workspace's roster.
- **The client only upgrades mermaid**, and the download dialog. Moving between
  pages is a plain link and a full server render, so what a reader sees is
  always what the API just authorised.
- **Download** (`ShareDownload.vue`) sits in the header when the link allows
  it. It is the app's format choice (`ExportFormatPicker.vue`, which the
  member export dialog also renders, with `lib/export-formats.ts`), but it
  talks to the API with plain `fetch` and the unlock cookie, polls the job and
  then navigates to the download route. The `export.*` strings it shares with
  the app are copied into the reader catalog. There, `export.pdfUnavailable`
  is worded for a reader and does not name an env var.

## Member UI

- **Share** in the page header (`SharePopover.vue`, editors, not on archived
  pages). It offers "include subpages", "let readers download it", an expiry
  preset (1 / 7 / 30 days / never), an optional password, copy and revoke.
  Each active link has a **Downloads** checkbox that turns download on or off
  in place. Its list call answers with the
  resolved `policy`, so a workspace with sharing off gets an explanation and,
  for an admin, a link to the switch.
- **Settings → Publishing** (`PublishingSettingsPage.vue`, admin): the two
  switches and an inventory of every link in the workspace (active, expired,
  revoked) with revoke.

## API and MCP

| Route | Access |
| --- | --- |
| `GET /v1/documents/:id/shares` | viewer (`document`) |
| `POST /v1/documents/:id/shares` | editor (`document`); 403 `details.reason: share.disabledByWorkspace` |
| `PATCH /v1/shares/:id`, `DELETE /v1/shares/:id` | editor (`share-link`) |
| `GET /v1/workspaces/:id/shares` | admin (`workspace`) |
| `GET/PATCH /v1/workspaces/:id/publishing-settings` | admin (`workspace`) |

`knowledge_share_page` is a **write** tool (`WRITE_TOOLS`, `editor`): hidden
from read-only keys, refused without the role. `allowDownload` turns download
on for the new link. Creating, changing and revoking
a link record `share.created` / `share.updated` / `share.revoked` in the
activity feed, filed under `curate`.

## Limits

- Everything a viewer can read can be shared by an editor. There are no
  page-level permissions to respect yet; when that milestone lands, links must
  refuse restricted pages.
- No view counts or "last opened". Public analytics belong to the usage
  analytics milestone.
- A shared subtree lists at most `SHARE_TREE_MAX` (500) pages, cut
  breadth-first so no listed page loses its parent.
- Mermaid diagrams in the reader need JavaScript. Every other block, drawings
  included, is static HTML.
