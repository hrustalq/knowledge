import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import type { ListWorkspacesResponse, WorkspaceSummary } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, setActiveWorkspace } from '@/lib/api'

/** The roster request in flight, per store instance — see stores/projects.ts (#279). */
const listFetches = new WeakMap<object, Promise<void>>()

/**
 * Workspace roster + the one place the active workspace is switched. Mirrors
 * stores/projects.ts; previously the roster fetch was inlined in AppSidebar and
 * AccessControlPage, and the search sheet needed it as a third copy.
 */
export const useWorkspacesStore = defineStore('workspaces', {
  state: () => ({
    items: [] as WorkspaceSummary[],
    loaded: false,
  }),
  actions: {
    fetchList(): Promise<void> {
      const pending = listFetches.get(toRaw(this))
      if (pending) return pending
      const job = (async () => {
        const res = await apiFetch<ListWorkspacesResponse>('/v1/workspaces')
        this.items = res.workspaces
        this.loaded = true
      })().finally(() => listFetches.delete(toRaw(this)))
      listFetches.set(toRaw(this), job)
      return job
    },
    /** Lazy, fire-and-forget: no roster access just leaves the switcher hidden. */
    ensureLoaded() {
      if (this.loaded) return
      void this.fetchList().catch(() => {
        this.loaded = true
      })
    },
    /**
     * Full reload, for the same reason switching project does one: the page
     * tree, query cache and live subscription are all scoped to the selection.
     */
    /**
     * After a deletion (#479): the roster drops it (the API no longer lists
     * it), and if it was the active one the app moves to the next it can see.
     */
    async forget(workspaceId: string) {
      await this.fetchList().catch(() => {
        this.items = this.items.filter((w) => w.workspaceId !== workspaceId)
      })
      if (workspaceId !== getWorkspaceId()) return
      setActiveWorkspace(this.items[0]?.workspaceId ?? null)
      window.location.assign('/documents')
    },
    switchWorkspace(workspaceId: string) {
      if (workspaceId === getWorkspaceId()) return
      setActiveWorkspace(workspaceId)
      window.location.assign('/documents')
    },
  },
})
