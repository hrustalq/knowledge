# 44 — Published sites

Issue [#77](https://github.com/hrustalq/knowledge/issues/77), phase 2a of
public publishing. A project, or one page and its subtree, published as a
read-only docs site: a nav tree, an outline, previous/next, a theme, and
versions. Anyone with the address can read it without signing in. Search,
`sitemap.xml`/`robots.txt`, `llms.txt`, custom domains and Caddy on-demand TLS
are phase 2b; audiences and the Ask widget are phase 3. Share links
([43](43-share-links.md)) are the other half of the same issue and share its
switches, rate limiter and reader.

## Public is opt-in twice

The same two switches as share links, one level up:

1. **The deployment.** `PUBLIC_SITES_ENABLED` (default `true`) is a ceiling.
   With it off, nothing can be published and every live site answers 404.
2. **The workspace.** `publishing_settings.allow_public_sites` is a sparse
   override whose code default is **off**. An admin allows sites in
   **Settings → Publishing**, beside the share-link switches.

A site can be created and configured only while sites are allowed, and it can
be **published** only then. A live site whose workspace switch is turned off,
or whose deployment ceiling is, stops resolving on the next request. Nothing
about the authorisation is cached.

## The snapshot is all the public ever reads

Three tables (`published_sites`, `site_versions`, `site_version_pages`):

- **`PublishedSite`**, one per project: `slug` (a DNS label, unique across the
  deployment; `RESERVED_SITE_SLUGS` names the platform's own hosts),
  `status` (`draft | live | unpublished`; only `live` is served),
  `root_document_id` (null = the whole project), `theme`, `seo_indexable` and
  `default_version_id`.
- **`SiteVersion`**: `name`, `slug` (its URL segment), `kind`, `source_branch`,
  and the last build's `status`, `built_at`, `page_count`, `warnings`, `error`.
- **`SiteVersionPage`**: one row per published page, pinning the revision it
  shows, with its place in the tree and its `slug_path`.

Public routes read `site_version_pages` and nothing else. They never ask for a
branch head. So:

1. **A change is not public until a build includes it.** `live` versions
   rebuild themselves; `frozen` ones only when someone presses Rebuild.
2. **A draft or a failed revision never leaks.** The builder takes only
   revisions with `status = 'indexed'`.
3. **A frozen version is frozen.** It keeps serving the revisions it pinned,
   whatever is merged afterwards. That is Docusaurus-style `v1.2` without git
   tags in the schema.

A version that has built once keeps serving its snapshot through a rebuild or
a failed one. Readers see the old pages until the new snapshot commits.

## Building a version

`SiteBuildService` (worker) reads the scope and `planSiteBuild` (pure, in
`site-build.plan.ts`) decides what is published:

- **Scope.** The project's unarchived pages, or the root page's subtree by
  `documents.path` (delimited at both ends). A root that has gone, been
  archived or moved to another project publishes nothing. The builder does not
  fall back to the whole project.
- **Which revision.** Per page, the branch named `source_branch` if the page
  has one, otherwise its default branch (a `null` source branch means every
  page's default branch). Then that branch's head if it is indexed, otherwise
  the newest indexed revision on it (warning `headNotIndexed`). A page with no
  indexed revision is left out (`noIndexedRevision`), and its subpages hang
  from its nearest published ancestor, so leaving out one page never hides a
  branch of the tree.
- **Order.** Position, then title: the order the app's own tree draws. A page
  whose parent is out of scope is top level (the `getTree` orphan rule).
- **Slugs.** One segment per level, from the title, through `slugifyPath`
  (contracts; the same function as the web's heading ids), with hyphen runs
  tidied. Unicode letters survive, so a Russian title keeps a Russian URL.
  Siblings are deduplicated with `-2`, `-3`. Top-level segments also step
  around the site's version slugs, which own a URL's first segment.
- **Root page.** With a root, the root is the home page at slug path `''`, and
  its subpages sit at the top of the URL space rather than under the root's
  own title.
- **Cap.** `SITE_MAX_PAGES` (2000) in reading order, then warning `pageLimit`.
- **The swap.** Delete the version's rows, insert the new ones and stamp
  `ready`, as **one** `$transaction`. A failed build marks the version
  `failed` and changes nothing a reader sees.

### When it runs

`SiteBuildProducer` enqueues on BullMQ queue `site-build`, deduplicated per
version (`site-build-<versionId>`, `keepLastIfActive`):

- **A change** waits `SITE_BUILD_DEBOUNCE_MS` (30 s), and every change inside
  that window rides along with the build already waiting. A change that lands
  **while** a build runs leaves exactly one more build behind it, so the
  snapshot catches up instead of missing the change until the next edit.
- **A person** (create, Rebuild, a new source branch, a new root) skips the
  wait. A build already waiting out its debounce is promoted rather than
  queued twice.

`SiteRebuildTrigger` (worker, beside the processor) listens on the event bus
for `revision.indexed`, `document.updated` (rename, move, reorder),
`document.archived` and `document.unarchived`. Merges need nothing of their
own, because the merge revision reaches `indexed` like any other. It finds a
page's versions two ways: the live versions of its project's site (a page that
is new or was moved in) and the live versions that already publish it (a page
moved out to another project must leave the old site too). Frozen versions are
never touched. On boot it requeues any version still saying `building`: crash
recovery for a build lost with Redis. The periodic sweep for stuck builds is
phase 2b's `PublishingSweeper`.

Builds create no page and attribute no act, so the worker completes them
itself. The API records `site.created|updated|published|unpublished|deleted`
and `site.version.created|updated|rebuilt|deleted`, all filed under `curate`.

## The anonymous read

`PublicSitesController` (`/v1/public/sites`, `@Public()`, under the same
per-IP `PublicRateLimitGuard` as shares, `Cache-Control: no-store`):

| Route | Answers |
| --- | --- |
| `GET resolve?slug=\|host=&path=&from=` | site chrome (title, normalized theme, logo, root URL), the version, every built version, the snapshot tree, and the page (markdown at its pinned revision, frontmatter stripped), or `page: null` |
| `GET :siteId/versions/:versionId/attachments/:attachmentId` | 302 to a presigned URL, only for an attachment of a page in that snapshot |
| `GET :siteId/logo` | 302 to the project's uploaded avatar, when the theme shows a logo |

- **Which site.** `slug` (path mode) or `host` (`<slug>.PUBLISH_BASE_DOMAIN`;
  one label only, so `a.b.docs.example.com` names nothing). Unknown, not live,
  switched off, or a default version that has never built: 404, no `details`.
- **Which version.** A first path segment matching a built version's slug
  selects it; otherwise the default version. The default version's own slug
  also works; the reader redirects it away.
- **Which page.** The exact slug path. The root path is the home: the `''`
  page of a one-page site, else the first page in reading order. With `from`
  (a version switch), a path the target lacks falls back to the same document
  there, then to its home. Without `from`, a path that is not in the snapshot
  gets `page: null`.
- **Never public.** Frontmatter, authors, revision ids, history, comments,
  relations. The response types are their own (`PublicSiteResolveResponse`),
  not member DTOs.

## The reader (web)

The share reader's public entry (`entry-public.ts`, `reader.html`,
`public-main.ts`) serves sites too. `public-main` picks `SitePage.vue` or
`SharePage.vue` from the view the server resolved.

- **Dispatch.** `server.js` sends `/pub/<slug>/…` to the public entry, and so
  any path on a host under `PUBLISH_BASE_DOMAIN` (the web container reads the
  same variable; `docker-compose.prod.yml` passes it). On a site host the
  AI-readable middleware is skipped: `/llms.txt` there belongs to the site
  (2b), not to a member's workspace. As for shares, nothing from the member's
  cookies reaches a site render.
- **One URL per page.** The home page lives at the version root, every other
  page at `[/<version>]/<slug path>`. Any other path that resolved to a page
  (the default version's own segment, the home's own slug, a version switch's
  `?from=`) gets a 302 to it. Links between pages and the nav are built by the
  same `siteHref`.
- **Server-rendered body.** `renderPublicMarkdown` with two different
  callbacks: page references resolve to the page's site URL **only** when the
  page is in the snapshot (anything else loses its link), and attachments go
  through the site attachment route.
- **Chrome.** The nav shows the top level plus the open path to the current
  page. A version switcher, "you are reading an older version" banner,
  outline and previous/next all work with JavaScript off. The client only
  upgrades mermaid and the theme toggle.
- **Theme.** `SiteTheme` (contracts) is values, never CSS: `#rrggbb` accent
  colours (light, and optionally dark), a font key into `SITE_FONT_STACKS`
  (system stacks only; a reader's browser fetches no web font), the project
  avatar as logo, up to five http(s) header links, and plain footer text.
  `siteThemeErrors` refuses a bad theme on write, and `normalizeSiteTheme`
  drops anything invalid on read. `siteThemeCss` turns the result into one
  `<style>` block (`html:root` / `html.dark`, so it outranks the app's own
  variables whatever order the stylesheets load in). No custom CSS or script.
- **Head.** `<title>`, description, canonical (absolute, from the site root
  URL), `og:*`, `twitter:card`. `noindex` (meta and `X-Robots-Tag`) when the
  site is not indexable, on every non-default version, and on a 404.
  `Cache-Control: no-cache`; the render cache is 2b.

## Member UI

- **Project settings → Published site** (`SiteSettingsPage.vue`,
  `/settings/projects/:id/site`). Anyone who can read the project sees it;
  the controls are an admin's. With no site there is a create form (address
  with a live preview of the URL, and "the whole project" or a root page).
  With one there is a status strip (Publish / Unpublish, the URL) and three
  tabs:
  - **General**: address, root, indexing, and delete. Delete is an inline
    second step, no browser dialog, and it frees the address.
  - **Theme**: colours, font, logo, links, footer, and a swatch preview.
  - **Versions**: each version's source, last build, page count and warnings,
    with Rebuild, Freeze / Follow branch, Make default and Delete. There is
    also an add form (name, optional address segment, kind, branch). The page
    polls only while a build is running.
- **Project overview**: a **Site** rail widget with the status, the live URL
  and a link to the settings.
- **Settings → Publishing** gains "Public docs sites" beside the share-link
  switches, and the `PUBLIC_SITES_ENABLED` notice.

## API

| Route | Access |
| --- | --- |
| `GET /v1/projects/:id/site` | viewer (`project`); answers the resolved `policy` too |
| `POST /v1/projects/:id/site` | admin (`project`); 403 `site.disabledByWorkspace`, 409 `site.exists` / `site.slugTaken` |
| `PATCH /v1/sites/:id`, `DELETE /v1/sites/:id` | admin (`site`) |
| `POST /v1/sites/:id/publish`, `…/unpublish` | admin (`site`) |
| `POST /v1/sites/:id/versions` | admin (`site`); 409 `site.versionSlugTaken` / `site.versionSlugShadowsPage` / `site.versionLimit` |
| `PATCH /v1/site-versions/:id`, `POST …/rebuild`, `DELETE …` | admin (`site-version`); deleting the default is 409 |

`WorkspaceSource` gains `site` and `site-version`, each resolved to its
workspace in PostgreSQL before the handler runs. Site management is not on MCP:
publishing is an admin act and stays in the UI.

**Deletes.** A project's site goes with the project in every delete mode
(empty, cascade, and move: the site describes this project, and the
destination may have its own). Deleting pages removes their snapshot rows
(`ProjectCascadeService`), since the revisions they pin are gone.

## Limits

- No search, `sitemap.xml`, `robots.txt`, `llms.txt`, custom domains or render
  cache yet (phase 2b). A subdomain under `PUBLISH_BASE_DOMAIN` needs 2b's Caddy
  on-demand TLS block in production; path mode works today.
- Slugs come from titles, so renaming a page changes its URL at the next
  build. There is no redirect history.
- Everything a viewer can read can be published by an admin. When page-level
  permissions land, builds must refuse restricted pages.
- `source_branch` falls back per page, so a "v2" version can mix branched and
  default pages. That is deliberate: a docs team branches the few pages that
  change.
- A version may not take a top-level page's slug when it is created, but a
  page renamed later onto a version's slug is pushed aside (`-2`) at its next
  build.
- A site lists every page of its version in the reader's state blob, which is
  fine at hundreds of pages and heavy at the 2000 cap.
