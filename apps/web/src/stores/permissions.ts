import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { defineStore } from 'pinia'
import { useQuery } from '@tanstack/vue-query'
import type { MePermissionsResponse, PermissionAction, ResourceAction, WorkspaceAction } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { PERMISSION_READS } from '@/shared/api/live-cache'

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
    /**
     * Read the grants again after the person's standing moved (#1297). The last
     * answer stays until the new one lands, so controls do not blink out, and
     * stays on a failed read: the API enforces either way.
     */
    async refresh(): Promise<void> {
      const workspaceId = getWorkspaceId()
      if (!this.loadedFor?.endsWith(`:${workspaceId}`)) return
      try {
        await bindStoreQuery<MePermissionsResponse>(
          this,
          'grants',
          this.queryClient,
          optionsFor(workspaceId),
          (res) => {
            this.grants = res
          },
          { fresh: true },
        )
      } catch {
        // see above
      }
      // The per-resource answers (#1298) moved with the person too.
      for (const key of PERMISSION_READS) void this.queryClient.invalidateQueries({ queryKey: [key] })
    },
  },
})

/** `GET /v1/documents/:id/permissions`, on the branch the page is read on (`?branch=`), if any. */
export const documentPermissionsQuery = (id: string, branch?: string | null) =>
  apiQueryOptions('/v1/documents/{id}/permissions', { path: { id }, ...(branch ? { query: { branch } } : {}) })

/** The read that carries a resource action's answer (#1298): the page's sibling route, or the project or merge request detail. */
function resourceQuery(
  action: ResourceAction,
  id: string,
  branch?: string | null,
): { queryKey: readonly unknown[]; queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown>; staleTime?: number } {
  if (action.startsWith('project:')) return apiQueryOptions('/v1/projects/{id}', { path: { id } })
  if (action.startsWith('merge-request:')) return apiQueryOptions('/v1/merge-requests/{id}', { path: { id } })
  return documentPermissionsQuery(id, branch)
}

/**
 * `usePermission('workspace:contribute')`, or `usePermission('document:edit',
 * documentId)` for a resource: reactive, for a component's setup. A resource
 * answer is read from the query that carries it, which the page has usually
 * asked already (same key, one request); `branch` is `branch:edit`'s. Until it
 * lands, and on a failed read, the answer is `false`: the API enforces either way.
 */
export function usePermission(action: WorkspaceAction): ComputedRef<boolean>
export function usePermission(
  action: ResourceAction,
  id: MaybeRefOrGetter<string | null | undefined>,
  branch?: MaybeRefOrGetter<string | null | undefined>,
): ComputedRef<boolean>
export function usePermission(
  action: PermissionAction,
  id?: MaybeRefOrGetter<string | null | undefined>,
  branch?: MaybeRefOrGetter<string | null | undefined>,
): ComputedRef<boolean> {
  if (id === undefined) {
    const store = usePermissionsStore()
    return computed(() => store.allows(action as WorkspaceAction))
  }
  const query = useQuery(
    computed(() => ({
      ...resourceQuery(action as ResourceAction, toValue(id) ?? '', toValue(branch)),
      enabled: !!toValue(id),
    })),
  )
  return computed(() => {
    const data = query.data.value as Record<string, unknown> | undefined
    const answers = (data && 'permissions' in data ? data.permissions : data) as Record<string, boolean> | undefined
    return answers?.[action] === true
  })
}
