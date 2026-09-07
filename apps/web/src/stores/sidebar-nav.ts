import { defineStore } from 'pinia'
import { getSidebarPane, setSidebarPane, type SidebarPane } from '@/lib/api'

/**
 * The sidebar's navigation stack: Projects → Pages, one column deep.
 *
 * The rail is a stack rather than two stacked lists because the domain is a
 * containment path (Workspace > Project > Document) and a 256px rail cannot
 * show three levels at once without every one of them being cramped. Pushing
 * trades breadth for depth on demand, and the direction of travel is what
 * tells you which way through the hierarchy you just moved — so `direction`
 * is state, not a parameter: the leaving pane has to animate out the same way
 * the entering pane animates in, and both read it on the same tick.
 *
 * The level is persisted (localStorage + cookie, SSR-readable) so a reload or
 * a full-page workspace switch lands you back where you were looking, not at
 * the top of the stack.
 */
export const useSidebarNavStore = defineStore('sidebarNav', {
  state: () => ({
    pane: getSidebarPane() as SidebarPane,
    /** Drives which transition plays; 'pop' only ever follows a `back()`. */
    direction: 'push' as 'push' | 'pop',
  }),
  actions: {
    go(pane: SidebarPane, direction: 'push' | 'pop') {
      this.direction = direction
      if (this.pane === pane) return
      this.pane = pane
      setSidebarPane(pane)
    },
    /** Deeper: into a project's pages. */
    openPages() {
      this.go('pages', 'push')
    },
    /** Back out to the project roster. */
    back() {
      this.go('projects', 'pop')
    },
  },
})
