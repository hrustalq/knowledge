import { defineStore } from 'pinia'
import type { ListWorkspacesResponse, WorkspaceSummary } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, setActiveWorkspace } from '@/lib/api'

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
    async fetchList() {
      const res = await apiFetch<ListWorkspacesResponse>('/v1/workspaces')
      this.items = res.workspaces
      this.loaded = true
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
    switchWorkspace(workspaceId: string) {
      if (workspaceId === getWorkspaceId()) return
      setActiveWorkspace(workspaceId)
      window.location.assign('/documents')
    },
  },
})
