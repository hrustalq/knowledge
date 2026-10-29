/// <reference lib="webworker" />
// The member app's service worker (#472). Built by vite-plugin-pwa
// (injectManifest), which fills in `self.__WB_MANIFEST` with the client build's
// hashed assets and offline.html.
//
// It stores code, never data. Every member page is server-rendered with that
// person's state serialized into it, so there is no app shell to keep: a
// navigation always goes to the network, and only when the network is gone
// does the precached offline page answer. API calls are not intercepted at all.
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Not the app's pages: the API, share links and path-mode sites (their own
// headers and caching, docs/features/43–44), and the export renderer.
const NOT_APP = /^\/(?:api|v1|s|pub|_internal)(?:\/|$)/

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.mode !== 'navigate' || NOT_APP.test(new URL(request.url).pathname)) return
  event.respondWith(
    fetch(request).catch(async () => (await matchPrecache('/offline.html')) ?? Response.error()),
  )
})

// The update toast's Reload (shared/utils/pwa.ts): the waiting worker takes over, and
// the page reloads onto the new build once it controls it.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})
