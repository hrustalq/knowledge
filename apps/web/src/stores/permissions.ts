import { computed } from 'vue'
import { defineStore } from 'pinia'
import type { MePermissionsResponse, WorkspaceAction } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

const optionsFor = (workspaceId: string) => apiQueryOptions('/v1/me/permissions', { query: { workspaceId } })

/**
 * What the caller may do in the active workspace (#1296), as the API answers
 * it: one boolean per workspace action of `@knowledge/contracts/permissions`.
 * Loaded by the router guard beside the features — on the server too, so the
 * first frame and the hydrated one draw the same controls — and again when the
 * person or the workspace changes (a switch is a full reload anyway).
 *
 * A failed or missing read answers `false`: a control the API would allow
 * stays hidden until the next load, and the API still enforces either way.
 */
export const usePermissionsStore = defineStore('permissions', {
  state: () => ({
    grants: null as MePermissionsResponse | null,
    /** `userId:workspaceId` the grants were read for. */
    loadedFor: null as string | null,
  }),
  getters: {
    allows: (s) => (action: WorkspaceAction): boolean => s.grants?.[action] ?? false,
  },
  actions: {
    /** `userId`: the signed-in person, passed by the guard (this store reads no other). */
    async ensureLoaded(userId: string | undefined): Promise<void> {
      const workspaceId = getWorkspaceId()
      const key = userId && workspaceId ? `${userId}:${workspaceId}` : null
      if (!key || this.loadedFor === key) return
      this.grants = null
      try {
        await bindStoreQuery<MePermissionsResponse>(this, 'grants', this.queryClient, optionsFor(workspaceId), (res) => {
          this.grants = res
        })
      } catch {
        // every action reads false; see above
      }
      this.loadedFor = key
    },
  },
})

/** `usePermission('workspace:contribute')`: reactive, for a component's setup. */
export function usePermission(action: WorkspaceAction) {
  const store = usePermissionsStore()
  return computed(() => store.allows(action))
}
