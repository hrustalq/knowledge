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
production, and in anything else reading the markdown. The environment prefix
and a `?token=` are added at render time, because `<img>` and `<object>` cannot
send an `Authorization` header — the same reason SSE accepts a query token
([08-events-live.md](08-events-live.md), [06-auth-acl.md](06-auth-acl.md)).

## Language, resolved twice the same way

`server.js` resolves the render's locale as `kn_lang` → `Accept-Language` →
`en`, matching on the primary subtag so `ru-RU` resolves to `ru`. The cookie
beats the header because the header is the browser's default while the cookie is
a decision someone made in this app. The same order is implemented on the API
side (plus `?lang=`), so both halves of a page agree.

The resolved locale is stamped into `<!--app-lang-->` and into the i18n instance
for that render, so the SSR HTML is already in the right language instead of
flashing English and swapping after hydration.

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

## Limits

Pinia state is transferred, but vue-query's cache is not: a server-rendered page
re-fetches on the client. Route-level data therefore arrives twice on first
paint for anything the stores do not hold.

`sirv` serves the built client directly out of the web process in production —
there is no CDN or asset host in front of it — and `server.js` is an Express app
with no rendering cache, so every request renders. Both are fine at the current
scale and are the first things to revisit if SSR latency becomes a problem.
