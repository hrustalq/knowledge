import { defineStore } from 'pinia'
import { getWorkspaceId } from '@/lib/api'
import type { SearchSnapshot } from '@/components/knowledge/use-search'

const PENDING_KEY = 'kn_search_pending'

interface PendingSearch {
  v: 1
  /** The workspace we were switching *to* — guards against a switch that failed. */
  workspaceId: string
  snapshot: SearchSnapshot
}

export interface SearchSeed {
  snapshot: Partial<SearchSnapshot>
  /** Project/tag filters were dropped because they belonged to the old workspace. */
  clearedFilters: boolean
}

/**
 * Open state for the global search sheet, kept in a store so the topbar trigger
 * stays decoupled from the sheet itself (mounted in App.vue).
 */
export const useSearchUiStore = defineStore('searchUi', {
  state: () => ({
    open: false,
    seed: null as SearchSeed | null,
  }),
  actions: {
    openSearch(seed: SearchSeed | null = null) {
      this.seed = seed
      this.open = true
    },
    close() {
      this.open = false
    },

    /**
     * Switching workspace reloads the whole app (the tree, query cache and live
     * subscription are all workspace-scoped), which would otherwise discard a
     * half-typed search. Stash it so the sheet can pick up where it left off.
     *
     * sessionStorage over a URL param: the reload lands on /documents, so the
     * state does not belong in that page's address, and per-tab scoping stops a
     * second tab from spontaneously opening a search sheet.
     */
    stashForWorkspaceSwitch(workspaceId: string, snapshot: SearchSnapshot) {
      if (import.meta.env.SSR) return
      const pending: PendingSearch = { v: 1, workspaceId, snapshot }
      try {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
      } catch {
        // Private mode / storage disabled — the sheet just won't reopen.
      }
    },

    /** One-shot restore after that reload. Client-only; call from onMounted. */
    hydrateFromSession() {
      if (import.meta.env.SSR) return
      let raw: string | null = null
      try {
        raw = sessionStorage.getItem(PENDING_KEY)
        // Read-and-delete, or the sheet reopens on every later reload.
        sessionStorage.removeItem(PENDING_KEY)
      } catch {
        return
      }
      if (!raw) return

      let pending: PendingSearch
      try {
        pending = JSON.parse(raw) as PendingSearch
      } catch {
        return
      }
      if (pending?.v !== 1 || !pending.snapshot) return
      // The switch did not actually take effect — don't reopen against the wrong data.
      if (pending.workspaceId !== getWorkspaceId()) return

      // Project ids and tag keys are workspace-scoped; carrying them over would
      // silently return nothing. Categories are a fixed enum, so they survive.
      const { projectIds, tags, ...rest } = pending.snapshot
      this.openSearch({
        snapshot: { ...rest, projectIds: [], tags: [] },
        clearedFilters: projectIds.length > 0 || tags.length > 0,
      })
    },
  },
})
