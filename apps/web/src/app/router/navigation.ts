/**
 * Route chunks ahead of the click, and a visible answer while one is awaited
 * (#627). Client only: installed by entry-client after the app has mounted, so
 * none of it runs in the SSR pass or competes with hydration.
 *
 * Every route is a lazy `import()`, and a navigation waits for its chunk with
 * the old page still on screen. Three things shorten or explain that wait:
 *
 * - each person's most-visited route *patterns* (`/documents/:id`, never an id
 *   or a query) are kept in their own browser and fetched once the shell is
 *   idle, topped up from the rail's destinations for a new browser;
 * - hovering or focusing an in-app link starts its chunk, and resting on a
 *   link to a page for DWELL_MS reads that page's detail and content into the
 *   query cache (#628), so the click draws it without a skeleton;
 * - a navigation still waiting after SLOW_MS publishes `slowNavigation`, which
 *   the shell's progress bar and the rail's links draw from.
 *
 * Nothing here is load-bearing: storage may be unavailable and the network
 * saving data, and the app behaves the same either way, only slower.
 */
import { shallowRef } from 'vue'
import type { RouteLocationNormalized, RouteRecordNormalized, Router } from 'vue-router'
import type { Pinia } from 'pinia'
import type { QueryClient } from '@tanstack/vue-query'
import { prefetchDocument } from '@/entities/document'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { HOME_NAV, KNOWLEDGE_NAV, PRIMARY_NAV, SETTINGS_NAV } from '@/app/shell/nav'
import { refusal } from './index'

/** Long enough that a warm navigation never flashes a bar or a spinner. */
const SLOW_MS = 150
/** A ring, so old habits age out. */
const HISTORY_SIZE = 50
const PREFETCH_COUNT = 5
/** Long enough that a pointer sweeping down the tree reads nothing, short enough to beat the click. */
const DWELL_MS = 100
/** Page reads in flight at once; a link rested on past this is read on the click instead. */
const MAX_PAGE_PREFETCH = 2
/** Every tree row first, then the rail top to bottom (the knowledge group opens closed). */
const SEED = [
  '/documents/:id',
  ...[HOME_NAV, ...PRIMARY_NAV, ...KNOWLEDGE_NAV, SETTINGS_NAV].map((l) => l.to),
]

/** The navigation that has been waiting longer than SLOW_MS, or null. */
export const slowNavigation = shallowRef<RouteLocationNormalized | null>(null)

/** Whether the rail's link to `to` is the one being waited on (a redirect counts). */
export function isSlowTarget(to: string): boolean {
  const n = slowNavigation.value
  return !!n && (n.path === to || n.redirectedFrom?.path === to)
}

export function installNavigation(router: Router, pinia: Pinia, queryClient: QueryClient) {
  const auth = useAuthStore(pinia)
  const features = useFeaturesStore(pinia)
  const historyKey = () => (auth.me ? `kn_route_visits:${auth.me.userId}` : null)

  function record(to: RouteLocationNormalized) {
    const key = historyKey()
    const pattern = to.matched.at(-1)?.path
    if (!key || !pattern || to.meta.public) return
    try {
      localStorage.setItem(key, JSON.stringify([...readVisits(key), pattern].slice(-HISTORY_SIZE)))
    } catch {
      // storage blocked or full: the history simply does not grow
    }
  }

  const started = new Set<unknown>()
  /** Loads the chunks `to` would wait on, once each — unless the guard would refuse it. */
  function prefetch(to: string) {
    if (!auth.authenticated || savingData()) return
    const route = router.resolve(to)
    if (!route.matched.length || route.meta.public || refusal(route, auth, features)) return
    for (const loader of route.matched.flatMap(lazyLoaders)) {
      if (started.has(loader)) continue
      started.add(loader)
      // A failure is the click's to report (the onError below); let it retry then.
      loader().catch(() => started.delete(loader))
    }
  }

  let pageReads = 0
  /** A page's detail and content, for `/documents/:id` only; the click joins or reuses them. */
  function prefetchPage(path: string) {
    if (pageReads >= MAX_PAGE_PREFETCH || !auth.authenticated || savingData()) return
    const route = router.resolve(path)
    if (route.matched.at(-1)?.path !== '/documents/:id' || refusal(route, auth, features)) return
    pageReads++
    void prefetchDocument(queryClient, route.params.id as string).finally(() => pageReads--)
  }

  const leafOf = (p: string) => router.resolve(p).matched.at(-1)?.path
  const adminOnly = new Set(KNOWLEDGE_NAV.filter((l) => l.workspaceAdmin).map((l) => l.to))

  function prefetchLikely() {
    const key = historyKey()
    if (!key) return
    // A pattern from an older build that no longer names its own record is dropped.
    const keep = (p: string) => leafOf(p) === p && (auth.canAdminWorkspace || !adminOnly.has(p))
    likelyRoutes(readVisits(key), SEED, keep, PREFETCH_COUNT).forEach(prefetch)
  }

  // Intent: the pointer or focus arriving on an in-app link. Delegated, so the
  // rail, the tree, breadcrumbs and links inside a page are all covered.
  // `pointerover` fires again on every element inside the same link, so the
  // dwell restarts only when the link under the pointer changes.
  let dwell: ReturnType<typeof setTimeout> | undefined
  let dwellOn: string | null = null
  const onIntent = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    const path = a && a.origin === location.origin && !a.hasAttribute('download') ? a.pathname : null
    if (path === dwellOn) return
    clearTimeout(dwell)
    dwellOn = path
    if (!path) return
    prefetch(path)
    dwell = setTimeout(() => prefetchPage(path), DWELL_MS)
  }
  document.addEventListener('pointerover', onIntent, { passive: true })
  document.addEventListener('focusin', onIntent)

  // Pending state. Compared by path because a superseded navigation still gets
  // its afterEach, after the next one has already started its timer.
  let waiting: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    clearTimeout(timer)
    waiting = null
    slowNavigation.value = null
  }
  router.beforeEach((to) => {
    clearTimeout(timer)
    waiting = to.fullPath
    timer = setTimeout(() => {
      slowNavigation.value = to
    }, SLOW_MS)
  })
  router.afterEach((to, from, failure) => {
    if (to.fullPath === waiting) settle()
    // A filter or a hash changing is not a visit, and would crowd the ring.
    if (!failure && to.path !== from.path) record(to)
  })
  // A chunk that will not load — most often one a deploy removed under an open
  // tab — becomes a full load of the target: the server renders it with the
  // current build's chunks, and the service worker answers navigations from the
  // network (src/sw.ts), so the reload cannot replay the stale one. Installed
  // after mount, so a failing first load cannot reload itself in a loop.
  router.onError((error, to) => {
    settle()
    if (isChunkError(error)) window.location.assign(to.fullPath)
  })

  record(router.currentRoute.value)
  whenIdle(prefetchLikely)
}

/** The most visited first (ties keep first-seen order), topped up from `seed`. */
export function likelyRoutes(visits: string[], seed: string[], keep: (p: string) => boolean, n: number): string[] {
  const counts = new Map<string, number>()
  for (const p of visits) counts.set(p, (counts.get(p) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([p]) => p)
  return [...new Set([...ranked, ...seed])].filter(keep).slice(0, n)
}

function readVisits(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** A record's `() => import()` loaders; routes here are lazy or SFC objects, never functional components. */
function lazyLoaders(record: RouteRecordNormalized): (() => Promise<unknown>)[] {
  return Object.values(record.components ?? {}).filter((c) => typeof c === 'function') as unknown as (() => Promise<unknown>)[]
}

function savingData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  return !!c && (!!c.saveData || /2g/.test(c.effectiveType ?? ''))
}

function whenIdle(fn: () => void) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 5000 })
  else setTimeout(fn, 2000)
}

// Chrome, Firefox, Safari, and Vite's preload helper, in that order.
const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

export function isChunkError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message)
}
