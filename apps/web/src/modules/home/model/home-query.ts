import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

/** The one read behind the home (#1243): entry-server prefetches it, so the page renders without JS. */
export const homeQuery = () => apiQueryOptions('/v1/workspaces/{id}/home', { path: { id: getWorkspaceId() } })
