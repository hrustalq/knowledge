import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiFetchText } from '@/lib/api'
import { createPageViewTracker, searchClickOf, TICK_MS, type PageViewTarget } from '@/lib/page-view'

const INPUTS = ['scroll', 'wheel', 'keydown', 'pointerdown', 'pointermove'] as const

/**
 * Record this page as read (#79): one view when `page()` names a page, then
 * its active read time. A search result link's `?sid=&rank=` is taken once
 * and stripped from the address. Client-only — nothing runs during SSR, and
 * the beacon is same-origin with the app's own credential: no cookie, no
 * third party. `onOpened` runs once the open beacon was accepted (not for a
 * heartbeat or a failed beacon), so a count read after it includes this view.
 */
export function usePageView(
  page: () => Omit<PageViewTarget, 'searchId' | 'searchRank'> | null,
  onOpened?: (documentId: string) => void,
) {
  const route = useRoute()
  const router = useRouter()
  let cleanup: (() => void) | null = null

  onMounted(() => {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
    const tracker = createPageViewTracker({
      // keepalive: the last beat is sent as the tab closes. The beacon answers
      // 204, which apiFetch's JSON parse would turn into a rejection.
      send: (path, body) => apiFetchText(path, { method: 'POST', body: JSON.stringify(body), keepalive: true }),
      opened: onOpened,
      visible: () => document.visibilityState === 'visible',
      now: Date.now,
      newId: () => crypto.randomUUID(),
      noTrack: nav.globalPrivacyControl === true || nav.doNotTrack === '1',
    })

    // The search the reader came from, for whichever page that link opened.
    let click: { documentId: string; searchId: string; searchRank: number } | null = null
    const { sid, rank, ...rest } = route.query
    if (sid !== undefined || rank !== undefined) {
      const c = searchClickOf(sid, rank)
      if (c) click = { documentId: route.params.id as string, ...c }
      void router.replace({ query: rest, hash: route.hash })
    }

    const stop = watch(
      page,
      (p) => {
        if (!p) return tracker.close()
        tracker.open(click?.documentId === p.documentId ? { ...p, ...click } : p)
        click = null
      },
      { immediate: true },
    )

    const onInput = () => tracker.input()
    const onHide = () => {
      if (document.visibilityState === 'hidden') tracker.flush()
    }
    for (const e of INPUTS) window.addEventListener(e, onInput, { passive: true, capture: true })
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', tracker.flush)
    const timer = setInterval(tracker.tick, TICK_MS)

    cleanup = () => {
      stop()
      clearInterval(timer)
      for (const e of INPUTS) window.removeEventListener(e, onInput, { capture: true })
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', tracker.flush)
      tracker.close()
    }
  })

  onUnmounted(() => cleanup?.())
}
