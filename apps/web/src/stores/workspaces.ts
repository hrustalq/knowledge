import { defineStore } from 'pinia'
import type { ListWorkspacesResponse, WorkspaceSummary } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { getWorkspaceId, setActiveWorkspace } from '@/shared/api/api'

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
    fetchList(opts: { fresh?: boolean } = {}): Promise<void> {
      // The rail, the breadcrumbs and the page ask on mount in the same tick;
      // the query cache joins them onto one request (#279).
      return bindStoreQuery<ListWorkspacesResponse>(
        this,
        'list',
        this.queryClient,
        apiQueryOptions('/v1/workspaces'),
        (res) => {
          this.items = res.workspaces
          this.loaded = true
        },
        opts,
      )
    },
    /** Lazy, fire-and-forget: no roster access just leaves the switcher hidden. */
    ensureLoaded() {
      if (this.loaded) return
      void this.fetchList().catch(() => {
        this.loaded = true
      })
    },
    /** After a rename (#478): patched in place, so the switcher shows it without a reload. */
    rename(workspaceId: string, name: string) {
      const ws = this.items.find((w) => w.workspaceId === workspaceId)
      if (ws) ws.name = name
    },
    /**
     * After a deletion (#479): the roster drops it (the API no longer lists
     * it), and if it was the active one the app moves to the next it can see.
     */
    async forget(workspaceId: string) {
      await this.fetchList({ fresh: true }).catch(() => {
        this.items = this.items.filter((w) => w.workspaceId !== workspaceId)
      })
      if (workspaceId !== getWorkspaceId()) return
      setActiveWorkspace(this.items[0]?.workspaceId ?? null)
      window.location.assign('/documents')
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
