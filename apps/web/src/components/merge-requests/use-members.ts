import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { ListWorkspaceMembersResponse, WorkspaceMemberEntry } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { actorLabel } from './mr-ui'

/** Workspace-member lookup shared by the MR surfaces (names + avatars for user ids). */
export function useMembers() {
  const query = useQuery(apiQueryOptions('/v1/workspaces/{id}/members', { path: { id: getWorkspaceId() } }))
  const members = computed(
    () => (query.data.value as ListWorkspaceMembersResponse | undefined)?.members ?? [],
  )
  const byId = computed(() => new Map(members.value.map((m) => [m.userId, m])))

  function memberOf(id: string | null | undefined): WorkspaceMemberEntry | undefined {
    return id ? byId.value.get(id) : undefined
  }
  function nameOf(id: string | null | undefined): string {
    return memberOf(id)?.displayName ?? actorLabel(id)
  }
  return { members, byId, memberOf, nameOf }
}
