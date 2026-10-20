# 44 — Published sites

Issue [#77](https://github.com/hrustalq/knowledge/issues/77), phases 2a, 2b
and 3 of public publishing. A project, or one page and its subtree, published
as a read-only docs site: a nav tree, an outline, previous/next, a theme, and
versions. Anyone with the address can read it without signing in. Phase 2b
adds custom domains, `sitemap.xml`/`robots.txt`, `llms.txt`, pages as
markdown, site search and a render cache. Phase 3 adds audiences: parts of a
site kept to workspace members, or to visitors a customer's backend signs in
with a JWT. The Ask widget is the last part of phase 3 and not built yet. Share links
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
recovery for a build lost with Redis. `PublishingSweeper` (API, every
`PUBLISHING_SWEEP_INTERVAL_MS`) covers the case where nothing restarted: a
version still `building` 15 minutes after its last status write
(`site_versions.updated_at`) is requeued, claimed by one guarded update.

Builds create no page and attribute no act, so the worker completes them
itself. The API records `site.created|updated|published|unpublished|deleted`
and `site.version.created|updated|rebuilt|deleted`, all filed under `curate`.

## The anonymous read

`PublicSitesController` (`/v1/public/sites`, `@Public()`, under the same
per-IP `PublicRateLimitGuard` as shares, `Cache-Control: no-store`):

| Route | Answers |
| --- | --- |
| `GET resolve?slug=\|host=&path=&from=` | site chrome (title, normalized theme, logo, root URL), the version, every built version, the nav's first render of the tree (below), and the page (markdown at its pinned revision, frontmatter stripped; its prev/next in reading order; where each page it links to lives), or `page: null`. Carries an `ETag`; a matching `If-None-Match` answers 304 without reading the body (see the render cache below) |
| `GET :siteId/tree?parent=&version=` | one level of the version's tree as the viewer sees it: the children of `parent` (the top level without it), each with its own `childCount`. A parent the viewer may not see, or that is not in the version, is a 404 (issue #204) |
| `GET :siteId/search?q=&version=&category=&tag=` | up to 20 pages of one version matching `q`, each with a snippet as text runs and its category and tags, narrowed by any repeated `category` / `tag`; any other parameter is a 400 (see Search) |
| `GET :siteId/facets?version=` | the categories and tags of the version's pages the viewer may read, each with a page count, for the reader's filter rail (#205) |
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
- **Which tree (issue #204).** `resolve` sends the top level and the children
  of every page on the path to the current one — never the whole tree, which
  for a large site shipped every title on every page load. Each node carries
  `childCount`, so an unexpanded branch still draws as a branch. What the
  trimmed tree can no longer answer is settled server-side over every visible
  row: `page.prev` / `page.next` walk the whole reading order, and
  `page.links` says where each page the body links to lives (the reader's
  only source for rewriting `/documents/<id>` links). The ETag also covers
  the ids of every row the viewer may see, because `links` is resolved after
  it: two viewers whose trimmed answers match but who see different pages
  must not share a cached render.
- **Never public.** Frontmatter, authors, revision ids, history, comments,
  relations. The response types are their own (`PublicSiteResolveResponse`),
  not member DTOs.

## Custom domains (phase 2b)

A site may also answer on hostnames its owner controls (`site_domains`, at
most `SITE_MAX_DOMAINS` = 5 per site, unique across the deployment).

- **Claiming.** An admin adds a hostname on the **Domains** tab. It is
  normalized to one spelling (`normalizeHostname`, contracts: lower-case
  IDNA, no scheme, path, port or trailing dot) and refused when it is one of
  the platform's own names (the app and API hosts, the base domain and
  anything under it, `.localhost`). The tab shows two records: a `CNAME` to
  `<slug>.PUBLISH_BASE_DOMAIN` (or the app's host in path mode) and a `TXT`
  at `_knowledge.<hostname>` holding `knowledge-site-verification=<token>`.
- **Proving.** Only the TXT record proves control. `SiteDomainsService.lookup`
  joins split TXT strings and tells three failures apart: `txtMissing` (DNS
  answered, no record of ours), `txtMismatch` (ours, another token) and
  `dnsError` (DNS did not answer). **Check now** looks it up at once;
  `PublishingSweeper` re-checks pending names every 5 minutes on their first
  day, hourly for the rest of a week, then stops. The verify write is guarded
  on `verified_at IS NULL`, so a click and a sweep record it once.
- **Holding.** An unproven claim holds nothing: another site adding the same
  name replaces it, and whoever proves control first keeps it. A verified
  name is refused to everyone else (409 `site.domainTaken`) until its admin
  removes it. Verified names are never re-checked, so deleting the TXT record
  afterwards does not take a site down; the cost is that a name whose owner
  changes stays with the site that proved it until removed.
- **Serving.** A verified domain resolves to its site in `resolve`, and the
  first verified one becomes the site's canonical root: canonical links,
  `og:url`, the sitemap and `llms.txt` all use it, wherever the page was
  opened.
- **Certificates.** `GET /v1/public/domains/allow?domain=` is Caddy's
  on-demand TLS `ask`. It answers 200 for an existing site's
  `<slug>.PUBLISH_BASE_DOMAIN` and for a verified custom domain, while the
  site's workspace allows sites, live or not (a site published later is
  already reachable over HTTPS), and 404 for everything else.
  `Caddyfile.sites.example` is the configuration for an install where Caddy
  faces the internet.
- **The switch.** `SITE_CUSTOM_DOMAINS` (default `true`) says whether this
  deployment routes custom hostnames at all. Off: the tab says so, adding or
  checking a domain is 403 `site.customDomainsOff`, no custom host resolves,
  the sweeper skips them, and canonical URLs fall back to the subdomain or
  path. Production runs it **off**: TLS there ends at a Cloudflare Worker in
  front of Tailscale Funnel, so Caddy can issue no certificates.
- **Trying it locally.** `make dev`'s web server refuses a custom host: Vite's
  dev server answers only hosts it knows (`localhost`, `.PUBLISH_BASE_DOMAIN`).
  Run the built web instead (`pnpm --filter @knowledge/web build`, then
  `NODE_ENV=production PORT=5174 node server` in `apps/web`), put
  `Caddyfile.sites.example` in front of it with `local_certs` in the global
  block, so Caddy's own CA stands in for ACME, and reach the host with
  `curl --resolve <host>:443:127.0.0.1 --cacert <Caddy's root.crt>`. This is
  how #77 was closed out: an unverified host failed the TLS handshake, a
  verified one got a certificate on its first request, and the member
  sign-in hand-off set its cookie on that host. Real ACME issuance and a real
  DNS verify have not been run, since no install of this platform faces the
  internet yet.

## Machine-readable files (phase 2b)

Generated per request from the version's snapshot rows, the same rows the
reader renders, so they cannot name a page the site does not publish
(`PublicSiteFilesService`, `GET /v1/public/sites/{sitemap.xml, robots.txt,
llms.txt, llms-full.txt, markdown}?slug=|host=`). The web serves them at the
site's own paths (`server/site-files.js`), on its host or under `/pub/<slug>`:

| Path | Answers |
| --- | --- |
| `/sitemap.xml` | The default version's pages at their canonical URLs (the home at `/`), `lastmod` from the pinned revision. Older versions are left out, as their pages say `noindex`. 404 when the site is not indexable. |
| `/robots.txt` | `Allow: /` plus the sitemap, or `Disallow: /` when the site is not indexable. |
| `[/<version>]/llms.txt` | The llmstxt.org index of a version: pages as `.md` links in reading order, then the other versions' `llms.txt`. |
| `[/<version>]/llms-full.txt` | Every page of the version at its pinned revision, streamed under `LLMS_FULL_MAX_DOCS` / `_BYTES`. |
| `/<page path>.md` | One page as markdown at its pinned revision. The home also keeps its own slug (`/welcome.md`); a version's `index.md` is its home. |

They are revalidated on every use (`Cache-Control: public, no-cache`) against
an ETag over the version id, its `built_at` and the site's root, so a 304
costs the site lookup and nothing else, and an unpublish ends them at once.
The `.md` and `llms*` files say `noindex`: they duplicate the HTML pages.

Each page's `<head>` also gains `<link rel="alternate">` to the same page in
every other built version that has it, and to its own `.md`. The resolve
answer carries those `alternates`, so the version switcher links straight to
the page rather than through `?from=`.

## The reader (web)

The share reader's public entry (`entry-public.ts`, `reader.html`,
`public-main.ts`) serves sites too. `public-main` picks `SitePage.vue` or
`SharePage.vue` from the view the server resolved.

- **Dispatch.** `server.js` sends `/pub/<slug>/…` to the public entry, and so
  any path on a site's host: one under `PUBLISH_BASE_DOMAIN` (the web container
  reads the same variable; `docker-compose.prod.yml` passes it), or a verified
  custom domain, asked of the API once a minute per host (see
  [09](../architecture/09-web-frontend.md)). The host is `X-Forwarded-Host`
  when the peer is internal, else `Host`. On a site host the AI-readable
  middleware is skipped: `/llms.txt` there belongs to the site, not to a
  member's workspace. As for shares, nothing from the member's cookies reaches
  a site render.
- **One URL per page.** The home page lives at the version root, every other
  page at `[/<version>]/<slug path>`. Any other path that resolved to a page
  (the default version's own segment, the home's own slug, a version switch's
  `?from=`) gets a 302 to it. Links between pages and the nav are built by the
  same `siteHref`.
- **Server-rendered body.** `renderPublicMarkdown` with two different
  callbacks: page references resolve to the page's site URL **only** when the
  page is in the snapshot (anything else loses its link), and attachments go
  through the site attachment route.
- **Chrome.** The nav is drawn by the app rail's own row and branch
  (`components/tree/TreeRow.vue`, `TreeBranch.vue`; `SidebarTreeNode` is the
  app's wrapper around them, `SiteTreeNode` the reader's), with the same
  indent rails and horizontal tree window (`lib/tree-window.ts`). It first
  renders what `resolve` sent — the top level and the open path, as plain
  links — and expanding any other branch asks the tree route for that one
  level, with a spinner on the row meanwhile (`site-tree.ts`); a collapsed
  branch is never fetched. A version switcher, "you are reading an older
  version" banner, outline and previous/next all work with JavaScript off.
  The client upgrades mermaid and the theme toggle, adds search, and loads
  deeper nav levels.
- **Layout.** The app shell's: a full-width header, the rail pinned to the
  window's left edge from `lg` (sticky under the header, scrolled to the
  current page on load), and the content column filling the rest. The prose
  keeps a 46rem measure inside that column; the outline sits at its right from
  `xl`. Below `lg` the rail is a drawer. It is always in the DOM and opens
  from `:target`, so the header's `#site-nav` link opens it with JavaScript
  off; with JavaScript the same links toggle `data-open` instead, Escape
  closes it and focus moves to its close control.
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
  `Cache-Control: no-cache`. Plus `<link rel="alternate">` to the page in the
  other versions and as markdown (phase 2b).

## Search

Postgres full-text search over the snapshot rows, nothing else (phase 2b-2;
decided over a per-version MiniSearch file in object storage, which would
have been a second copy of the snapshot to keep in step).

- **What is indexed.** The build stores each page's headings and body as plain
  text on its `site_version_pages` row (`search_headings`, `search_body`;
  `site-search.text.ts` walks `marked`'s tokens: markup, mermaid source and
  control characters out, code kept, the body capped at 100k characters), and
  the same swap transaction computes `search_vector`: title weight A,
  headings B, body C. Text is per revision, so a rebuild copies it from any
  row that already holds that revision and reads only new revisions from
  object storage. A revision that cannot be read is searched by its title and
  logged; it does not fail the build.
- **One configuration for both languages.** `russian` stems Cyrillic words with
  the Russian stemmer and ASCII words with the English one, so
  `установк` finds «Установка» and `install` finds "Installing".
- **The query.** `siteSearchQuery` keeps only letters and digits, ANDs up to
  eight words and makes the last one a prefix, so results follow the typing;
  under 2 characters answers nothing without asking Postgres. Ranked by
  `ts_rank_cd` (length-normalised), then reading order. `ts_headline` marks hits
  with two control characters the stored text cannot hold, and the API turns
  them into `{ text, hit }` runs, so no markup reaches the reader as HTML.
- **Scope.** `liveSite` first (the same check every public route makes), then
  one statement over `site_version_pages WHERE version_id = …`. A draft, an
  unpublished page or another version's page has no row there, and there is
  no semantic path: the workspace-wide vector index is never consulted.
- **Facets (#205).** Each row also carries the page's `category` as the build
  read it and its pinned revision's frontmatter `tags` (jsonb, `[{key, name}]`:
  `key` folded by `tagEntityKey` exactly as the graph folds it, `name` the
  author's spelling). Both are snapshot columns, never a join to `documents` or
  the graph, so a frozen version filters by the facets it was built with.
  `category` and `tag` filters AND together; the values of one facet OR. The
  route accepts only `SITE_SEARCH_PARAMS` (`q`, `version`, `category`, `tag`):
  a workspace, project or mode is refused rather than ignored, so nobody
  believes a filter applied that was dropped. `GET :siteId/facets` counts both
  over the rows the viewer may read, so a value only a hidden page carries is
  never offered.
- **Older snapshots.** Rows written before the migration have no vector, and
  rows from before #205 no tags (`tags IS NULL`; their category was copied
  from `documents` by the migration). The worker fills them at boot from their
  pinned revisions (`SiteSearchTextService.backfill`), matched on revision so
  a build that swapped in meanwhile is not overwritten. It never rebuilds a
  version, so a frozen version stays frozen. A row with no tags yet is never a
  source for the per-revision text copy.
- **Reader.** `pages/public/SiteSearch.vue` renders the app's own search
  components (#205): `SearchSheetFrame` (the sheet, focus handling, the
  re-run on a facet change), `SearchPanel`, `SearchResults` and `FacetFields`,
  all store-free. The app's `SearchSheet` mounts the same frame over its
  stores. What differs is the `SearchSource` passed to `useSearch`
  (`app-search-source.ts` vs `site-search-source.ts`) and the filters slot:
  the app passes its workspace/project/mode rail, the reader only the
  category field (when the version has more than one category) and the tag
  field. Failures from the public route (too short, 429, offline) are
  `SearchNotice`s shown as written. Results follow the typing, as before; the
  same "/" and ⌘K shortcut and focus return on close
  (`lib/search-shortcut.ts`). It needs JavaScript; nothing else in the reader
  does.

## The render cache

`server.js` keeps finished site renders in a least-recently-used map bounded
by bytes (`server/render-cache.js`, `SITE_RENDER_CACHE_MB`, default 32, 0 off),
keyed by host, language and URL — an anonymous site render reads no cookie,
so those decide its bytes (a signed-in reader's render is never kept, see
Audiences). Each entry holds the ETag `resolve` gave for what it was
made from: a hash of the whole answer with the markdown replaced by the
pinned revision id, which names it.

Every request still calls `resolve`, with that tag. The site, its status and
the workspace switch are looked up afresh, so an unpublish is a 404 on the
next request exactly as before. A 304 means nothing the render used has
changed (a rebuild changes `builtAt` and the tree, a theme edit the site, a
rename the title), and the cached HTML is sent without the body read, the
markdown render, the sanitiser or the Vue SSR pass. On the dev stack a
640 KB page went from about 105 ms to about 21 ms. Only pages served as
themselves (200) are kept; shares never are, since their render carries no
tag. The cache is per process and starts empty on restart, which is also how
a new web build arrives.

## Audiences (phase 3)

A site is public by default. An admin keeps parts of it from the public with
**rules** on the site's **Audience** tab: a rule on a page covers that page
and everything below it, and says who may read them.

| Rule | Who reads it |
| --- | --- |
| *(none above the page)* | everyone |
| `visitors` | workspace members, and visitors signed in with a JWT whose claims match the rule's |
| `members` | workspace members only |

**Rules only restrict, and they add up down the tree** (`foldSiteAudience` in
contracts). `members` outranks `visitors`; two nested `visitors` rules must
both hold (claims merge, a key in both keeps only the values both allow). So a
subpage is never more open than its parent — it could not be: its URL carries
the parent's slug and its nav place sits under the parent.

**Per site, stamped onto every version.** Rules live in
`site_audience_rules (site_id, document_id, audience, claims)`, not on a
version. Each snapshot row carries the folded result in `audience` and
`audience_claims`, and the reader filters on the row alone.
`SiteAudienceStamper` writes those columns:

- **On a rule change**, API-side, before the route answers: every version of
  the site, frozen ones included. What a frozen version freezes is its
  content, not who may read it.
- **In a build**, as the rows are written, with a restamp right after the swap
  to close the window in which a rule changed while the build ran.
- **When a page moves** (`document.updated`), worker-side in
  `SiteRebuildTrigger`, for every site that has rules and publishes the page:
  it may have moved under a rule or out from under one.

The fold reads `documents.path`, so a page is judged where it is now. The
reader also requires a row's published parent to be visible
(`visibleRows`), so a stale stamp can never show a page whose parent is
hidden.

### Who is reading

A sign-in is a random value in an httpOnly `kn_site_<siteId>` cookie on the
site's own origin; Redis maps its hash to the session for
`SITE_VISITOR_TTL_MIN` (default 1440). Nothing in the cookie is trusted but
its key, and every check is against the world as it is now
(`SiteSessionService.viewer`):

- **Members.** The reader's **Sign in** link goes to the app's
  `/site-sign-in?site=&return=` page. The router guard sends a signed-out
  person through `/login` first. The page posts
  `POST /v1/sites/:id/sign-in` (`viewer` on the site's workspace), which checks
  that `return` is one of the site's own addresses — `/pub/<slug>` under
  `WEB_BASE_URL`, its `<slug>.PUBLISH_BASE_DOMAIN`, or a verified domain —
  and mints a one-time code (2 minutes, spent with `GETDEL`). The browser goes
  to `<site origin>/api/v1/public/sites/:id/session?code=&return=<path>`, which
  sets the cookie on that origin and redirects back. A member session is good
  only while the person still has a role in the workspace and an enabled
  account. In `AUTH_MODE=none` the dev principal is a member.
- **Visitors.** The admin generates a secret (32 random bytes, shown once,
  stored with the secret box, so `SETTINGS_ENCRYPTION_KEY` is required). The
  customer's backend signs an HS256 JWT with it, with an `exp` claim, and
  sends the visitor to any page of the site with `?jwt_token=<token>`. The web
  render passes that to the session route and comes back to the same path
  without it, with `Referrer-Policy: no-referrer`. A token that is not HS256,
  not signed with the site's secret, expired, not yet valid (`nbf`) or has no
  `exp` signs no one in. The session lasts until the token's `exp`, at most
  `SITE_VISITOR_TTL_MIN`, and is bound to the secret: replacing or clearing it
  signs every visitor out at once.
- **Anyone else** — no cookie, an unknown or expired session, a Redis outage —
  is anonymous and sees the public pages.

Sign-out is `POST /v1/public/sites/:id/session/end`, which deletes the
session and clears the cookie.

### What a reader who may not see a page gets

Nothing that confirms it exists. The page is absent from the tree, its path
renders the site's own 404, its attachments are 404, it is left out of search
in the SQL statement itself, and no other version names it as an alternate.
On a site with any non-public page the reader shows **Sign in**, and its 404
says that some pages need it; that names no page.

`sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt` and `<page>.md` are
**public pages only, whoever asks**. They are for crawlers and agents and never
vary by cookie. Since a restamp changes rows without a build, the restricted
ids are part of each file's ETag.

The resolve ETag covers the viewer, so a cached render never crosses a
sign-in. `server.js` also keeps any request carrying a `kn_site_` cookie out
of the render cache: those renders are one reader's, and caching them would
only evict the anonymous render everyone shares. It forwards `kn_site_*`
cookies to the API beside `kn_share_*`, and never `kn_token`.

## Ask (phase 3)

A site can answer questions from its own pages: an **Ask** button beside
search in the reader, and a widget other sites embed. An admin turns it on
in the site's **Ask** tab. It is off for every existing site.

**One call, no tools** (`PublicAskService`, `public/public-ask.service.ts`).
There is no tool harness, no thread and no principal. A question goes
through these steps:

1. The live-site check every public route makes, then Ask on with a budget
   left (otherwise a 404 `publicAsk.notEnabled`).
2. The per-address rate (`PUBLIC_ASK_RATE_PER_MIN`, Redis, **fails closed**:
   an answer costs money). 429 `publicAsk.rateLimited`.
3. The workspace's model (`resolveFor(ws, 'chat')`) and its AI budget
   (`assertWithinBudget(ws, siteId)`). Either missing is a 503
   `publicAsk.unavailable`: a visitor never sees the provider's own wording.
4. Retrieval, from the version's snapshot rows **this viewer may read**
   (`visibleRows`, the reader's own rule, so a hidden page is never ranked,
   quoted or cited):
   - **semantic:** the question's embedding against the chunks of exactly
     those rows' pinned revisions (`GraphService.searchRevisionChunks`). This
     works for live or history chunks, so a frozen version answers from what
     it froze. A chunk whose document does not match its pinned row is dropped.
   - **keyword:** Postgres FTS over the same rows' `search_vector`, with the
     words **ORed** (site search ANDs them, which suits typing, not asking),
     and an excerpt per page from `ts_headline`.
   - Fused by reciprocal rank at page level: at most 5 pages and 2 passages
     a page, each up to 1,500 characters, labelled `S1…`. An embedding outage
     leaves the keyword leg; nothing at all answers `{answer: '', sources: []}`
     **without spending the budget**.
5. The site's daily budget (`askDailyBudget ?? PUBLIC_ASK_DAILY_BUDGET`,
   never above the env, Redis, per UTC day, fails closed). 429
   `publicAsk.budgetExhausted` with `retryAfter` to midnight UTC.
6. One completion. The passages go in the user turn inside
   `wrapUntrusted(…, 'page')`; the rules go in the system turn. The call is
   billed as `public_ask` with `userId` = the site's id, and AI usage labels
   it `site: <slug>`.
7. `finalizeCitations` against the labels handed out: a label the model
   invented is stripped, and `sources` are the cited passages as absolute
   page URLs (the home at the version root, a non-default version under its
   segment) plus their heading path for the anchor.

**The reader** (`SiteAsk.vue`) is the same panel in both places: the reader's
sheet and the widget's frame. It loads the markdown parser, DOMPurify and the
citation pass (`lib/citations.ts`, shared with the app's assistant, as are the
chip styles in `styles/citations.css`) only on the first answer. A chip or a
source opens the page at the passage's heading. In the reader it asks with
the reader's cookie, so a signed-in reader's answers may draw on pages others
cannot see.

**The widget.** `<script src="<site>/widget.js" async></script>`:

- **`widget.js`** (`apps/web/server/site-widget.js`) is the same bytes for
  every site. It is served at `/widget.js` on a site's host and at
  `/pub/<slug>/widget.js`, cacheable for an hour, `Cross-Origin-Resource-Policy:
  cross-origin`. It derives its frame from its own `src`, so it carries no
  site id and asks the API nothing. It draws a button and a panel in a
  closed shadow root, and accepts messages only from that frame's origin
  and window.
- **The frame** is `<site>/_widget`, a page of the site itself rendered by
  the public entry (`SiteWidget.vue`). It is same-origin with the site's API,
  so **no CORS**. Its `Content-Security-Policy: frame-ancestors 'self'
  <site origin> <embedOrigins…>` is the whole embed check: anywhere else, the
  browser refuses the frame. It answers 404 (and `frame-ancestors 'none'`)
  when Ask is off.
- The frame posts `ready` (with the label and the theme's primary colour)
  only once it has mounted with Ask on, and the button stays hidden until
  then. So a page on an unlisted origin, or one embedding a site without
  Ask, shows nothing. `close` and `focus` are the other two messages. None
  carries anything a stranger could use.
- An embedded frame is usually cross-site, so the site's `SameSite=Lax`
  cookie is not sent and it answers from public pages. A same-site embedder
  (`docs.example.com` on `example.com`) does send it.

**Settings** (`SiteAskPanel.vue`): on/off, answers a day (empty = the env
value), the effective budget beside it with a note when the env caps it,
embed origins one per line (`normalizeEmbedOrigin`: https, or http on a
loopback host; a pasted URL is reduced to its origin; at most 20), and the
snippet with a copy button. Warnings show when the workspace has no model or
the env turns Ask off.

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
  - **Domains**: see above.
  - **Audience** (admins only; `SiteAudiencePanel.vue`): the rules in tree
    order with edit and remove, a form (page, who may read it, claims as one
    `name=value, value` line each), and visitor sign-in: generate, replace or
    turn off the secret (both of the last two ask a second time, inline), the
    secret shown once with a copy button, and an example payload and link.
  - **Ask**: see above.
- **`/site-sign-in`** (`SiteSignInPage.vue`): the member hand-off above. It
  says why when it cannot sign someone in (no access to the workspace, a link
  that is not for this site).
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
| `POST /v1/sites/:id/domains` | admin (`site`); 400 `site.domainInvalid` / `site.domainReserved`, 403 `site.customDomainsOff`, 409 `site.domainExists` / `site.domainTaken` / `site.domainLimit` |
| `POST /v1/site-domains/:id/verify`, `DELETE /v1/site-domains/:id` | admin (`site-domain`); verify answers the domain either way, with `lastError` |
| `GET /v1/sites/:id/audiences` | admin (`site`): the rules and whether visitor sign-in is configured |
| `PUT /v1/sites/:id/audiences/:documentId`, `DELETE …` | admin (`site`); 400 `site.audiencePageNotInSite` / `site.audienceClaimsInvalid`, 409 `site.audienceRuleLimit` (200) |
| `POST /v1/sites/:id/visitor-secret`, `DELETE …` | admin (`site`); 409 `site.visitorSecretNeedsKey` without `SETTINGS_ENCRYPTION_KEY` |
| `POST /v1/sites/:id/sign-in` | viewer (`site`); 400 `site.signInReturnInvalid` |
| `GET /v1/public/sites/widget?slug=\|host=` | public: the widget frame's chrome and `embedOrigins`; 404 when Ask is off |
| `POST /v1/public/sites/:id/ask` `{question, version?}` | public: 404 `publicAsk.notEnabled`, 429 `publicAsk.rateLimited` / `publicAsk.budgetExhausted`, 503 `publicAsk.unavailable` |
| `GET /v1/public/sites/:id/session?code=\|jwt_token=&return=`, `POST …/session/end` | public: always a 302 back to `return` (a path on the same origin, else `/`), with the cookie set when the code or token was good |

`WorkspaceSource` gains `site`, `site-version` and `site-domain`, each
resolved to its workspace in PostgreSQL before the handler runs. Site management is not on MCP:
publishing is an admin act and stays in the UI.

**Deletes.** A project's site goes with the project in every delete mode
(empty, cascade, and move: the site describes this project, and the
destination may have its own). Deleting pages removes their snapshot rows
(`ProjectCascadeService`), since the revisions they pin are gone.

## Limits

- Search is keyword only. Ask has a semantic leg (scoped to the snapshot's
  pinned revisions); the search box does not.
- Search needs JavaScript. There is no server-rendered results page.
- Production serves sites in path mode only: its TLS ends at Cloudflare, so a
  base domain or a custom domain needs the edge to route those hosts first.
  `Caddyfile.sites.example` covers an install where Caddy faces the internet.
- Slugs come from titles, so renaming a page changes its URL at the next
  build. There is no redirect history.
- A verified domain stays verified; one whose owner changes stays with the
  site that proved it until an admin removes it.
- Everything a viewer can read can be published by an admin. When page-level
  permissions land, builds must refuse restricted pages, and `members` must
  mean "may read this page", not "has a role in the workspace".
- Visitor sign-in is a customer-signed JWT only; there is no OIDC for
  visitors. A visitor's claims are read once, at sign-in: a plan that changes
  takes effect at the next sign-in.
- A site sign-in is per origin. A site served on both its subdomain and a
  custom domain needs a sign-in on each, and sign-in returns to the address
  the reader came from.
- Ask is one question, one answer: no follow-ups and no streaming. Nothing is
  stored, so there is no history and no feedback on a public answer.
- Ask's semantic leg asks the chunk vector index for the nearest chunks of
  the snapshot's pinned revisions (#304). Until the worker has built the
  index, it scans them instead, capped at 5,000 chunks.
- The daily budget counts questions that reach the model, including ones the
  provider then refuses.
- A top-level page slugged `_widget` is shadowed by the widget's frame.
- `source_branch` falls back per page, so a "v2" version can mix branched and
  default pages. That is deliberate: a docs team branches the few pages that
  change.
- A version may not take a top-level page's slug when it is created, but a
  page renamed later onto a version's slug is pushed aside (`-2`) at its next
  build.
- A site lists every page of its version in the reader's state blob, which is
  fine at hundreds of pages and heavy at the 2000 cap.
- A top-level page whose slug is `index` takes `/index.md` from the home page;
  the home is still `/<its slug>.md`.
