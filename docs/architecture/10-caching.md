# 10 — Caching

What may be kept where, and what decides it. Five layers hold copies of an
answer, and each one is allowed a different kind:

| Layer                                                     | Holds                                                        | Shared between people? |
| --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| [Query cache](#the-web-client-one-client-one-cache)       | Every answer the web app shows, per tab                      | No                     |
| [Browser HTTP cache](#cache-control-on-every-response)    | Authenticated GETs (revalidated), revisions (for a year)     | No                     |
| [Redis read cache](#the-redis-read-cache)                 | Scope-free answers: revision bytes, query embeddings, settings | Yes, every process     |
| [Service worker](#the-service-worker)                     | The build's code and an offline page                         | No, and no data at all |
| Published-site render cache                               | Rendered public pages ([44](../features/44-docs-portal.md#the-render-cache)) | Yes, public content only |

**The rule all five follow:** an answer that depends on who asks — anything
filtered by an `AccessScope`: pages, trees, search results, lists — is kept
only by a cache that belongs to the person who asked. It never goes into Redis,
a shared proxy or the service worker. PG makes the final visibility decision on
every request ([06](06-auth-acl.md)), and a stale shared copy would leak a page
past a restriction made after it was stored.

The design was issue #472. Where the code went another way than the issue's
plan, the section says so.

## The web client: one client, one cache

Every call the web app makes to the API goes through the generated client
(`api/client.ts`, [07](07-api-client-errors.md)), and every read whose data is
shown goes through TanStack Query: `apiQueryOptions` in a component, or
`fetchApi` / `queryClient.fetchQuery` from a store or a route guard. One key
holds one answer, so a store and a component can no longer show two versions of
the same page, and a live invalidation ([08](08-events-live.md)) reaches both.

**Raw `fetch` is a lint error.** `apps/web/eslint.config.js` (`RAW_FETCH`)
flags `fetch(`, `window.fetch(`, `globalThis.fetch(` and `self.fetch(`
everywhere except `RAW_FETCH_OK`. Each entry there names why XHR cannot do the
job: a streamed body (`lib/assistant-stream.ts`), a keepalive beacon that
outlives the tab (`lib/use-page-view.ts`), the try-it console and browser suite
runs (the request is the reader's own), the public SSR entry (no member client,
no credential), and the service worker. File downloads go through
`requestFile` on the same axios stack. Presigned uploads go to object storage,
not the API, over XHR (`lib/presigned-put.ts`, the only way to report upload
progress).

**Freshness is set per query family** in one map, `queryTimes()` in
`api/queries.ts`, keyed by the URL template that heads every query key:

- **30 s** (the default) for anything a peer's write moves: lists, pages,
  threads, the tree.
- **5 min** for rosters, catalogues and settings (`/v1/me`, workspaces,
  projects, glossary, templates, the AI pickers, every settings route). They
  change when an admin edits them, and the edit invalidates its own key.
- **Forever** (`staleTime: Infinity`, evicted after 30 min unused) for answers
  addressed by an immutable id: a page's content at a named `revision`, a
  template at a numbered version.

`refetchOnWindowFocus` is off. The live feed already says when something
changed, and a refetch on every alt-tab would be a second, blind version of it.

**Stores read from the cache.** A Pinia store that still exposes server data
(the project roster, the tree, the glossary…) keeps its shape and actions, but
`bindStoreQuery(store, slot, queryClient, options, apply)` puts the answer in
the cache under the same key components use. On the client a `QueryObserver`
keeps that query active, so an invalidation refetches it and `apply` writes the
new answer back into the store. Rebinding the same slot with another key (a
project switch) moves the observer instead of adding one. During SSR it is one
fetch, and the key is remembered: `entry-server.ts` dehydrates exactly those
store-bound queries into `window.__QUERIES__` (`isStoreQuery`), and
`entry-client.ts` hydrates them before the stores rebind. A component's own
`useQuery` data is not transferred and is fetched again after hydration
([09](09-web-frontend.md#limits)).

Two traps the move to the cache uncovered:

- An imperative `queryClient.fetchQuery` inherits the client's retry policy.
  Where the caller handles the failure itself, pass `retry: false`.
- `createQueryClient()` is per app instance, never module scope. A shared cache
  would serve one user's documents to the next SSR render
  ([09](09-web-frontend.md#a-fresh-app-per-request)).

Signing out calls `queryClient.clear()` (`stores/auth.ts`), so nothing the
signed-out session read can answer for the next one.

## Cache-Control on every response

`HttpCacheInterceptor` (`apps/api/src/common/http-cache.ts`, registered in
`main.ts`) sets `Cache-Control` and `Vary` on every response **before** its
handler runs. A handler that sets its own header still wins, which is how the
public routes keep theirs. Three policies:

| Policy       | `Cache-Control`                         | Used for                                                                   |
| ------------ | --------------------------------------- | -------------------------------------------------------------------------- |
| `revalidate` | `private, no-cache`                     | The default for every GET and HEAD                                         |
| `immutable`  | `private, max-age=31536000, immutable`  | A page's content at a revision named in the request                       |
| `no-store`   | `no-store`                              | The default for every write; sign-in, session, `/me`, SSO, IdP and SCIM-token controllers |

`@CachePolicy(name)` overrides the default for a route or a whole controller.
`setCachePolicy(res, name)` is for a handler whose policy depends on the
request: content is `immutable` only when the revision was named, because an
`asOf` that resolves to one still means "now" for a future date.

Everything except `no-store` also gets
`Vary: Authorization, Cookie, Accept-Language`. The browser may keep the
response, but it must never answer one session's request, or one language's,
from another's copy. Nothing authenticated is `public` or carries `s-maxage`
(`test/http-cache.spec.ts` pins it).

**Between the browser and the API**, neither proxy stores anything. Caddy's
`encode` only appends `Accept-Encoding` to `Vary`. The edge Worker
(`deploy/edge/worker.js`) fetches a `ts.net` origin that is not on Cloudflare,
so Cloudflare caches nothing and `Vary` passes through.

The web process sets its own headers on what it serves: hashed assets are
`immutable` for a year, and the HTML shells, `sw.js` and the manifest are
`max-age=0, must-revalidate`. A member's SSR render is `private, no-cache`
([09](09-web-frontend.md)).

> **Divergence from the plan.** #472 also listed exported files as
> `immutable`. Exports are served through their own presigned URLs
> ([45](../features/45-export.md)) and were left alone.

## Cheap 304s

Express's default weak ETag already answers `304 Not Modified` for an unchanged
body, but only after the handler has run every read behind it. That saves
bytes, not work. Where the expensive part of an answer is not PG, the handler
is split into a cheap half and an expensive half, and
`notModified(req, res, …validator)` sits between them:

1. The handler reads only what its answer depends on, from PG.
2. `notModified` hashes that, together with `Accept-Language` (messages in the
   body are translated), into a strong ETag, sets it, and compares it with
   `If-None-Match` (`etagMatches`, RFC 9110 weak comparison).
3. On a match it sets 304 and the handler returns `undefined` without doing the
   expensive half. Otherwise the ETag rides on the full answer.

| Route                            | Validator (PG)                                   | Read it skips          |
| -------------------------------- | ------------------------------------------------ | ---------------------- |
| `GET /v1/documents/:id`          | `getDocumentHead`: the detail without its chunks | ArcadeDB (`withChunks`) |
| `GET /v1/documents/:id/content`  | `contentRevision`: the revision id, plus `asOf`  | MinIO (`readContent`)  |

`@Returns(name, { conditional: true })` lets such a handler return `undefined`
and still type-checks the JSON shape ([07](07-api-client-errors.md)).

**Every other route keeps Express's body ETag.** The tree, the revision list,
MR detail and the settings routes are PG-only, so a validator would cost about
as much as the handler.

**ACL-dependent answers never share a validator across callers.** The page
detail and content validators carry no scope because the answer is the same for
everyone the route guard admits (the guard refuses the rest before the handler
runs). Answers filtered by an `AccessScope` (the tree, lists) keep the body
hash. Two callers share that ETag only when they were sent byte-identical
bodies, so a 304 can never confirm bytes a caller would not have received.

> **Divergence from the plan.** #472 proposed a validator of "version + scope
> fingerprint" for every hot GET. The scope part turned out to add code without
> saving a read: the routes that would need it are exactly the PG-only ones.

## The Redis read cache

`ReadCache` (`apps/api/src/cache/read-cache.service.ts`, in the controller-free
`ReadCacheCoreModule`, so both the API and the worker have it) is a small
read-through cache over its own ioredis client:

- **`wrap(namespace, key, load, ttlMs?)`** returns the cached answer, or
  `load()`'s, which it stores for next time.
- **`invalidate(namespace, key)`** drops one key.
- **`invalidateWorkspace(id)`** drops all of a workspace's keys. Workspace
  teardown ([65](../features/65-workspace-deletion.md)) calls it, so a deleted
  workspace's bytes do not wait for their TTL.

Keys are `cache:{workspaceId | global}:{family key}`, and every key has a TTL.
**It fails open.** With `READ_CACHE_ENABLED=false` (the default) there is no
client, and every read goes to its source exactly as before. With it on, Redis
down, slow or holding a bad value falls through to the source as well. The
connection is lazy, with one retry and a 2 s connect timeout, so the OpenAPI
generator boots with no Redis, and a dead Redis costs one read two seconds once,
not every read.

The families, with what invalidates each, are declared together in
`READ_CACHE_FAMILIES` so a new one cannot be added without saying:

| Family           | Key                                     | TTL           | Invalidated by                                 |
| ---------------- | --------------------------------------- | ------------- | ---------------------------------------------- |
| `content`        | `content:{revisionId}`                  | 24 h          | Nothing: a finalized revision never changes    |
| `embedding`      | `embedding:{signature}:{sha256(text)}`  | 24 h          | Nothing: the signature names the vector space  |
| `healthSettings` | `health-settings` (per workspace)       | env default   | `VerificationPolicyService.update`, its one writer |

- **`content`**: a revision's raw bytes, read by `DocumentsService.readContent`
  on every content GET that is not a 304.
- **`embedding`**: the single-text `embed` call that every search, ask and
  capture dedupe makes. The cache wraps the provider in `embedding.module.ts`,
  so every caller gets it. `embedBatch` (indexing) is not cached: its texts do
  not repeat.
- **`healthSettings`**: the sparse knowledge-health override, read on every page
  detail and every search (trust weight, [39](../features/39-page-verification.md)).

**What it will not hold:** anything filtered by an `AccessScope`, and anything
carrying a credential. That second rule is why resolved AI settings are not
cached even though the issue listed them: a resolved provider config holds a
decrypted key ([`ai/secret-box.ts`](../../apps/api/src/ai/secret-box.ts)).

> **Divergence from the plan.** #472 planned invalidation through the event
> bus, with a subscriber in each API process. Every process shares one Redis,
> so a `DEL` at the single write site reaches all of them at once, workers
> included. A subscriber would have been a second path to the same result,
> plus a window where the event is in flight.

Env, both defaulted: `READ_CACHE_ENABLED` (`false`) and
`READ_CACHE_DEFAULT_TTL_MS` (`3600000`), for a family that names no TTL of its
own. The cache stays off in production until it has been measured there.

## The service worker

The member app is installable: a hand-written `public/manifest.webmanifest`,
PNG icons rendered from `favicon.svg`, light and dark `theme-color`, and a
service worker. **It stores code, never data.**

`src/sw.ts` is built by `vite-plugin-pwa` with `injectManifest`. The plugin
compiles it to `dist/client/sw.js` and fills `self.__WB_MANIFEST` with the
client build's files, and it skips the SSR build. It:

- **precaches** `assets/**` (the hashed JS, CSS, fonts and images), `offline.html`
  and the favicon, through `workbox-precaching`, which also serves them and
  removes stale revisions when a new worker activates;
- **sends every navigation to the network**, and answers with the precached
  `offline.html` only when the network is unreachable. No HTML shell is
  precached: every member page is server-rendered with that person's state
  serialized into it ([09](09-web-frontend.md)), so there is nothing generic to
  keep. `index.html` and `reader.html` are SSR templates, not pages, and stay
  out of the precache;
- **never touches** `/api`, `/v1`, `/s`, `/pub` or `/_internal` navigations,
  and no API call at all: there is no `respondWith` for them, so the browser
  handles them as if the worker were not there.

The manifest is linked from `index.html` only. The plugin's generated manifest
was turned off because it injects its `<link>` into every HTML input, which
would have put it in the public reader's shell. Site hosts never register the
worker.

**`lib/pwa.ts`** is the page half, started from `App.vue` once it mounts:

- **Updates**: `registerSW` in prompt mode. A new deploy changes `sw.js`, the
  new worker installs in the background and waits, and a persistent toast
  offers **Reload**. Pressing it posts `SKIP_WAITING`, and the page reloads
  once the new worker controls it. Until then the old worker keeps serving the
  old build's lazy chunks, so an open tab does not 404 on a chunk the deploy
  removed. An open SPA tab never navigates, so the browser would never look for
  a new worker by itself: `registration.update()` runs hourly.
- **Offline**: a persistent toast while `navigator.onLine` is false
  (`useOnline`), dismissed when the connection returns. TanStack refetches on
  reconnect by itself.
- **Logout**: `clearPwaCaches()` deletes every Cache Storage entry and
  unregisters the worker, after `queryClient.clear()`. The next full page load
  installs it again with a fresh precache, offline page included. A workspace
  switch clears nothing, because the worker holds nothing workspace-scoped.

The precache is about 8.5 MiB before compression (404 entries). It is fetched
once, in the background, on the first visit after a release, and only changed
hashes after that.

In dev the plugin's `virtual:pwa-register` is a no-op stub, so no worker runs
under `make dev`. Vitest stubs the virtual module in `vitest.config.ts`, and
dependency-cruiser exempts `^virtual:` from `not-to-unresolvable`.

**Testing it** takes a production build (`pnpm --filter @knowledge/web run build`,
then `NODE_ENV=production node server.js` from `apps/web`). Two things mislead:

- Chrome's offline emulation does not apply to the worker's own `fetch`. To see
  `offline.html`, stop the server.
- In production, `sirv` reads file stats at startup. A rebuilt `sw.js` is
  served only after a restart, which a deploy does anyway.

## Before caching something new

- **Does the answer depend on who asks?** Then the only places it may live are
  the browser's HTTP cache (`private`) and the query cache. Not Redis, not the
  worker.
- **Is it addressed by an id whose content never changes?** Then it can be
  cached for as long as you like: `immutable` over HTTP, `FOREVER` in
  `queryTimes`, no invalidation in Redis.
- **Otherwise name its invalidation**, at the write site, next to the key
  (`READ_CACHE_FAMILIES`) or in `live-cache.ts`. A TTL is the backstop, not the
  plan.
- **Does it carry a credential?** Then it is not cached anywhere.
