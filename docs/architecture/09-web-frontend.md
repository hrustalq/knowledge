# 09 — The web app: SSR, per-request state, cookies

## What this is

`apps/web` is a server-rendered Vue app on the create-vite-extra skeleton:
`server.js` runs Vite's middleware in dev and `sirv` in production, calls
`render(url, ctx)` from `src/entry-server.ts`, and splices the result into
`index.html`. Everything below is about one problem — **a server process
renders for many users at once** — and the conventions that keep one request's
state from leaking into another's, or the server's idea of a locale from
disagreeing with the browser's after hydration.

## The render

`server.js` reads the template fresh on every dev request (through
`vite.transformIndexHtml`) and from a cached string in production, then fills
four placeholders: `<!--app-lang-->`, `<!--app-css-->`, `<!--app-head-->` and
`<!--app-html-->`.

`<!--app-css-->` exists only for dev: Vite injects CSS through the JS module
graph, so the server-rendered HTML would paint unstyled until `entry-client`
loads — a FOUC plus layout shift. In dev the global stylesheet is linked
directly (`/src/style.css` is served as real CSS); `vite build` already stamps a
`<link>` into `index.html` for production.

A render failure logs the stack and returns a bare `500 Internal Server Error`.
It used to send the stack as the response body, which hands anyone who can
trigger a render error the server's internal paths and dependency layout.

`traceMiddleware` is registered **first**, before Vite's middlewares and the SSR
handler, so every response carries `x-request-id` — static-asset 404s included —
and the id is passed into the render, which is what puts the browser's request,
the render, and every API call that render makes on one trace
([07-api-client-errors.md](07-api-client-errors.md) for where it resurfaces).

### The public entry

`/s/*` (a share link), `/pub/<slug>/*` (a published site in path mode) and
every path on a site's own host are matched before any cookie is read and
rendered by a second entry,
`src/entry-public.ts`, into its own shell, `reader.html`, with its own client
entry and app (`public-main.ts`: no router, Pinia, query client or auth guard;
`SharePage` or `SitePage` by the view resolved) (docs/features/43, 44). It
receives only the language, the `kn_share_*` and `kn_site_*` cookies (share
unlocks and site sign-ins, both scoped to one link or site) and the visitor's
`X-Forwarded-For`; `kn_token` never reaches a public render. A request with a
`kn_site_*` cookie skips the site render cache: its render is one reader's. The render
returns its own headers (a share's no-referrer/noindex/no-store, a site's
robots rule) and may answer with a redirect to a page's one canonical URL. Its
page body is HTML from `lib/markdown/public-render.server.ts`, which sanitizes
with `SANITIZE_CONFIG` over a jsdom window. That is the one server-side
sanitizer, and the reason `MarkdownView` can keep rendering nothing during SSR.
Vite builds both apps in one pass (`rolldownOptions.input`), and the reader
carries its own small i18n catalog rather than sharing the app's.

Both SSR bundles leave `vue` and `vue-i18n` external, so in production Node
loads their published builds with no compile-time `define`. vue-i18n's
`install()` then reads Vue's `__VUE_PROD_DEVTOOLS__` flag, which nothing
defines under plain Node. A member render happened to define it first, so a
public page rendered first after boot threw inside that async `install()`,
and the unhandled rejection killed the process. `server.js` therefore defines
the flag itself before anything renders. Dev never shows this: with
`NODE_ENV` unset the check short-circuits before reading the flag.

A site sign-in crosses both apps (docs/features/44, "Audiences"). The
reader's Sign in links to the member app's `/site-sign-in`, an ordinary
route behind the login guard. That page asks the API for a one-time code and
`location.replace`s to the site's own `/api/v1/public/sites/:id/session`,
which reaches the API through the front proxy's `/api` route (Vite's proxy in
dev) on whatever origin the site has: path mode, a base-domain host or a
custom domain. The cookie is therefore set on the site's origin and never
on the app's.

The Ask widget ([44](../features/44-docs-portal.md#ask-phase-3)) is two
routes. `/widget.js` (`server/site-widget.js`, mounted before the reader so
it is not taken for a page) is a static script, the same bytes for every
site. `/_widget` is a page of the public entry (`SiteWidget.vue`), and its
render returns the `Content-Security-Policy: frame-ancestors` header built
from the site's `embedOrigins`, which is the only thing standing between the
frame and an origin the admin did not list.

Whether a host is a site's is decided once per request, first thing
(`server/site-files.js`, `res.locals.siteHost`). The host is `Host`, or
`X-Forwarded-Host` when the peer is internal. In production that header is
Caddy's to write: Funnel overwrites the Worker's copy with the `*.ts.net` name,
so the Worker sends the visitor's host as `X-Knowledge-Host` beside a shared
secret, and the Caddyfile promotes it to `X-Forwarded-Host` only when the secret
matches (#174). A host
under `PUBLISH_BASE_DOMAIN` is a site's by its shape; the app's own host
(`WEB_BASE_URL`) never is; any other host is asked of the API
(`/v1/public/domains/allow`, the check Caddy's on-demand TLS also makes) and
the answer is cached for a minute, a failed lookup not at all. On a site, the
AI-readable middleware steps aside and `siteFilesMiddleware` proxies the
site's `sitemap.xml`, `robots.txt`, `llms*.txt` and `<page>.md` to
`/v1/public/sites/*`, with no cookie or credential, through the same `relay`
the AI-readable routes use.

### The export renderer

`POST /_internal/export/render` (`server/export-render.js`, mounted before
the host check) is how the worker gets an export's HTML
([feature 45](../features/45-export.md)). It calls a third SSR module,
`src/export-render.ts`, which renders each page with `renderPublicMarkdown`
and wraps the pages in the app's own stylesheets: `styles/tokens.css` (the
palette, kept out of `style.css`'s Tailwind entry so it can be inlined) and
`styles/editor.css`. It answers only an internal peer whose request carries no
`X-Forwarded-*` header, which is never a request through Caddy. The module is a
third SSR input in `vite.config.ts`.

## A fresh app per request

`src/main.ts` is a factory, not a module-scope app:

```ts
export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia(); const router = createRouter()
  app.use(createI18nFor(getLocale()))
  app.use(pinia); app.use(router)
  app.use(VueQueryPlugin, { queryClient: createQueryClient() })
  installAuthGuard(router, pinia); installViewTransitions(router)
  return { app, router, pinia }
}
```

App, router, pinia, query client **and i18n instance** are per request on the
server and per page load in the browser. `entry-server.ts` pushes the URL,
awaits `router.isReady()`, renders, and serializes `pinia.state.value` into
`window.__PINIA__` with `<` escaped to `<` so a string in the state cannot
break out of the script tag. `entry-client.ts` assigns that back into
`pinia.state.value` before mounting.

`createI18nFor(locale)` is the sharpest case of the rule: created at module
scope, two concurrent SSR renders share one `locale` object and one request
renders in the other's language ([../features/18-i18n.md](../features/18-i18n.md)).
The same applies to `createQueryClient()` — a shared cache would serve one
user's documents to the next.

## Per-request context without module state

`lib/api.ts` is imported by everything and has to answer "what is the current
token / workspace / locale" in both environments. In the browser those live in
module variables hydrated from `localStorage`. On the server they come from an
`AsyncLocalStorage` scope installed by `entry-server.ts`:

```ts
const ssrCtx = new AsyncLocalStorage<SsrRequestContext>()
;(globalThis as Record<string, unknown>).__KN_SSR_CTX__ = ssrCtx
```

It is published on `globalThis` rather than imported, so `lib/api` — which ends
up in the client bundle — never imports `node:async_hooks`. Every accessor
branches on `import.meta.env.SSR` and reads `ssrContext()?.x`, which means
concurrent renders can never observe each other's tokens, and every setter is a
no-op during SSR.

The context carries `token`, `workspaceId`, `projectId`, `pane`, `rail`,
`railOpen`, `filterRail`, `glossary`, `treeOpen`, `locale` and `traceId`.

## The cookie set

localStorage is the durable client copy; a **cookie mirror exists for exactly
one reason** — it is the only source readable before any JavaScript runs, so it
is what lets the server draw the first frame correctly. Every one of these
decides something visible in that frame, which is why they are cookies and not
just storage keys.

| Cookie           | Meaning                          | Polarity when unset |
| ---------------- | -------------------------------- | ------------------- |
| `kn_token`       | session/API token (mirrors localStorage; `SameSite=Lax`, not httpOnly — it is readable client-side anyway) | anonymous |
| `kn_ws`          | active workspace                 | the demo workspace (`DEMO_WORKSPACE_ID`) |
| `kn_proj`        | active project ([../features/11-projects.md](../features/11-projects.md)) | `null` = the whole workspace |
| `kn_lang`        | UI language (mirrors `users.locale`) | `Accept-Language`, then `en` |
| `kn_pane`        | sidebar navigation level         | `projects` |
| `kn_rail`        | rail width in px (clamped on read — a cookie is user-editable) | store default |
| `kn_railopen`    | app rail open                    | **open** — the rail is how you get anywhere |
| `kn_filterrail`  | merge-request filter rail open   | **closed** — a tool you reach for, not the page |
| `kn_glossary`    | glossary linking in page content | **on** — it is what the feature does |
| `kn_tree`        | open page-tree branches, `.`-joined, capped at 40 | `null` = top level expanded |

The polarities are the interesting part: each is chosen so that a first visit,
with no cookie at all, renders the state a newcomer should see. And each is read
server-side because reading it after hydration is visible — a rail someone
widened renders narrow and jumps, a rail they collapsed renders open and
animates shut on _every_ page load, remembered tree branches open a frame late
with one row jumping per branch, and every glossary link on the page pops in.

`server.js` reads them with a minimal `readCookie` and hands them to `render()`;
`entry-server.ts` puts them in the ALS scope; `lib/api` accessors return them.
The chain only works if all three know the name, so a new one costs an entry in
each.

## The API base URL split

```ts
const base = import.meta.env.SSR
  ? (process.env.API_URL_INTERNAL ?? 'http://localhost:3000')
  : (import.meta.env.VITE_API_URL ?? '/api')
```

The server talks to the API directly; the browser goes through the Vite dev
proxy, which rewrites `/api` away and forwards to `API_URL_INTERNAL` — so the
browser is always same-origin and there is no CORS configuration anywhere. Both
HTTP stacks (`lib/api.ts`'s `apiFetch` and `api/http.ts`'s axios instance) spell
the same rule, and both attach `Authorization`, `Accept-Language` and
`x-request-id`.

`resolveAssetUrl()` is the exception that proves the rule: attachment and avatar
links are stored in markdown as bare `/v1/...` paths with no host and no
credential, so the same document renders correctly through the dev proxy, in
production, and in anything else reading the markdown. Only the environment
prefix is added at render time. `<img>` and `<object>` cannot send an
`Authorization` header, so those routes authenticate from the `kn_token` session
cookie instead, never a token in the URL (#102, [06-auth-acl.md](06-auth-acl.md)).
That holds only while the API is same-origin under `/api`; a cross-origin
`VITE_API_URL` would 401 every attachment and avatar. The client re-writes the
cookie from `localStorage` on every load, so its 30-day max-age cannot lapse
under a live session.

## Language, resolved twice the same way

`server.js` resolves the render's locale as `kn_lang` → `Accept-Language` →
`en`, matching on the primary subtag so `ru-RU` resolves to `ru`. The cookie
beats the header because the header is the browser's default while the cookie is
a decision someone made in this app. The same order is implemented on the API
side (plus `?lang=`), so both halves of a page agree.

The resolved locale is stamped into `<!--app-lang-->` and into the i18n instance
for that render, so the SSR HTML is already in the right language instead of
flashing English and swapping after hydration.

The client reads it back from `<html lang>` before anything else, and only falls
back to its stored choice when that attribute is missing. Storage alone is not
enough: a visitor with no `kn_lang` cookie gets the `Accept-Language` language
from the server, and a client hydrating in its own default instead mismatches
every string on the page (#278). On load the client also re-writes the cookie
from storage, the same renewal the token gets.

## Shared state the server filled after drawing

`window.__PINIA__` is the store as it stood at the **end** of the render, not
when each component drew. The rail renders before the page, so when a page's
`onServerPrefetch` loads something the rail also reads (the page tree on
`/documents`), the server drew the rail's skeleton but the client hydrates with
the data present, and the two disagree. The rail's tree therefore waits for
`onMounted` (the `mounted` ref below) and adopts the rows one frame later.

The fix for the common case is to have the data before anything draws.
`entry-server.ts` runs `prefetchShell` between `router.isReady()` and the
render, on every route that draws the shell (authenticated, not `meta.public`,
not pending email verification). It loads the project roster and the tree's
first level, so the rail and the breadcrumbs are in the HTML (#279). The
remembered project's tree is fetched alongside the roster. When the roster
resolves another project (the cookie's is gone, or there is none), the render
switches its own `projectId` to that one and fetches its tree instead.
`entry-client.ts` then adopts the resolved id with `setActiveProject`, so the
client's API calls ask for the scope the page was drawn in. When the tree
loaded, `documents.treePrefetched` is set, and the rail draws rows on the
server and on the client's first render alike. Without it (the prefetch failed,
or a page loaded the tree later) the rail keeps the skeleton until mount, as
above. A failed prefetch never fails the render. The store stays unloaded and
the client fetches as before.

Rows drawn on the server bring two more rules. Anything they start must not run
during setup. `SidebarTreeNode` fetches an open row's children from a
`watchPostEffect`, which never runs on the server and runs after the row has
hydrated on the client. A fetch from setup would mark the row `loading` before
its first draw. `revealPath` returns at once during SSR. The rail and the
breadcrumbs call it from immediate watchers that the render does not await, so
its answer would land in the serialized state after the rows were drawn without
it.

The stores' in-flight dedupe (`treeFetches`, `listFetches`, …) keys its
WeakMaps by `toRaw(this)`, never by `this`. In development Pinia's devtools
plugin calls each action of an options store through a fresh `Proxy` of it, so
a key of `this` never matched and every caller sent its own request.

## Intl wrappers, because "no locale" means "the host"

`lib/format.ts` wraps every date, number, relative-time and byte-size format.
The reason is precise: a bare `toLocaleString()` / `toLocaleDateString()` call
passes no locale, which means _follow the host_ — the browser on the client and
**the server's own locale during SSR**. The two disagree the moment a user picks
a language, and disagreeing text inside the same DOM node is a hydration
mismatch. So the locale is always explicit, and always the app's.

`BCP47` maps the app's locales onto real tags (`en` → `en-GB`, `ru` → `ru-RU`),
`Intl.DateTimeFormat` instances are cached per tag+options because constructing
them inside a list is expensive, and `formatRelative` uses
`Intl.RelativeTimeFormat` so Russian gets its own plural forms without a
hand-written table — falling back to a date past a month, where a relative
phrase stops being informative. `relativeTime()` stays exported from `lib/api`
as the entry point its call sites already import.

## Client-only libraries

Anything that touches `window` or produces markup the client would discard has
to be kept out of the SSR pass, and the pattern is always the same: a `mounted`
ref, flipped in `onMounted`, guarding the element.

`@vue-flow/core` in `components/workflows/WorkflowGraphEditor.vue` is the
canonical case — Vue Flow is client-only, so the canvas renders nothing on the
server; `Autocomplete.vue` guards its `<Teleport>` for the same reason. Vue Flow
also ships unstyled and its node positioning _is_ CSS, so both
`@vue-flow/core/dist/style.css` and `theme-default.css` are imported or the
canvas renders blank with the nodes present in the DOM. (It was chosen over
cytoscape because cytoscape nodes cannot be Vue components;
[../features/17-workflows.md](../features/17-workflows.md).)

`startLive()` throws under SSR outright, and `stores/events.ts` returns early —
neither an `EventSource` nor a `WebSocket` has any meaning during a render.

Co-editing ([56](../features/56-realtime-coediting.md)) goes one step further:
`components/editor/use-collab.ts` (Yjs, the Hocuspocus provider, IndexedDB) is
a **dynamic import** that `EditorPage` makes in `onMounted`, and only after
`GET /v1/collab/capabilities` says `enabled`. The server render and a
deployment with the flag off never load Yjs at all; the SSR pass renders the
editor's existing skeleton. In collab mode the editor never calls
`setContent`, because the Y.Doc is the only writer of the body.

## Limits

Pinia state is transferred, but vue-query's cache is not: a server-rendered page
re-fetches on the client. Route-level data therefore arrives twice on first
paint for anything the stores do not hold.

`sirv` serves the built client directly out of the web process in production —
there is no CDN or asset host in front of it — and `server.js` is an Express app
that renders every request of the member app. Only published site pages are
cached (`server/render-cache.js`: an in-process LRU revalidated against the
API's `resolve` ETag on every request, see
[44](../features/44-docs-portal.md#the-render-cache)). Both are fine at the
current scale and are the first things to revisit if SSR latency becomes a
problem.
