import { defineStore } from 'pinia'

/**
 * Chrome state that outlives a route but not a session.
 *
 * The app already has two homes for layout state and this is deliberately a
 * third, because the two that exist answer different questions:
 *
 * - `lib/api.ts` accessors (cookie + localStorage) hold what the *first painted
 *   frame* depends on — the rail's width and open state. Those earn a cookie
 *   because reading them after hydration means a rail that visibly jumps.
 * - `route.query` holds what a colleague should see when you paste the link —
 *   which tab, which widget, which saved view.
 *
 * What is left is the set of small preferences that should survive walking from
 * one page to the next and are not worth putting in either: chiefly, which rail
 * widgets you keep open. Today every document page opens with exactly
 * `['overview']`, so a reader who always checks Revisions opens it again on
 * every page they visit. Remembering it here means the rail arrives configured
 * the way they left it.
 *
 * Session-scoped on purpose — in memory, not persisted. The rail is
 * server-rendered, so a remembered set restored from storage after hydration
 * would open three widgets a frame late and push the page down under the
 * reader. Within one session the store is the same on both sides of every
 * navigation, so there is nothing to mismatch; across sessions the page simply
 * starts from its default, which is the state SSR already drew.
 */
export const useLayoutStore = defineStore('layout', {
  state: () => ({
    /**
     * Open rail widgets, keyed by surface (`document`, `project`, …).
     *
     * Keyed rather than global because the widget vocabularies do not overlap:
     * a project rail has no `revisions`, and a single shared set would carry
     * ids from one surface into another that has no such widget.
     */
    railOpen: {} as Record<string, string[]>,
    /**
     * Sub-rail open state, keyed by surface. Only for rails that do not already
     * own a cookie — the merge-request filter rail keeps `kn_filterrail`,
     * because it is drawn on the first frame and this is not.
     */
    subRailOpen: {} as Record<string, boolean>,
  }),
  getters: {
    /**
     * Which widgets are open on this surface, or `null` when the reader has not
     * touched this surface's rail yet.
     *
     * `null` and `[]` have to stay distinguishable: the first means "use the
     * page's default", the second means "the reader closed everything". Without
     * the distinction, closing the last widget would silently re-open the
     * defaults on the next navigation.
     */
    openWidgets: (s) => (surface: string): string[] | null => s.railOpen[surface] ?? null,
    isSubRailOpen: (s) => (surface: string, fallback: boolean): boolean =>
      s.subRailOpen[surface] ?? fallback,
  },
  actions: {
    setWidgetOpen(surface: string, id: string, open: boolean, current: string[]) {
      const next = open ? [...new Set([...current, id])] : current.filter((x) => x !== id)
      this.railOpen = { ...this.railOpen, [surface]: next }
    },
    setSubRailOpen(surface: string, open: boolean) {
      this.subRailOpen = { ...this.subRailOpen, [surface]: open }
    },
  },
})
