/**
 * Scope creation (workspace, project) in one place.
 *
 * Both POSTs are issued from more than one surface now — the sidebar switcher,
 * the projects rail, and the follow-up steps a create dialog offers once the
 * first thing exists — so the request shapes live here rather than being
 * retyped at each call site.
 */
import type {
  CreateWorkspaceResponse,
  ProjectSummary,
} from '@knowledge/contracts'
import { api } from '@/shared/api/queries'

/** What a create dialog hands back once the whole flow (create + follow-up) is done. */
export interface ScopeCreated {
  kind: 'workspace' | 'project'
  id: string
  name: string
}

export async function createWorkspace(name: string): Promise<CreateWorkspaceResponse> {
  return api.post('/v1/workspaces', { body: { name } })
}

/**
 * `workspaceId` is explicit rather than read from the active scope: a project
 * created as the follow-up to a new workspace belongs to *that* workspace,
 * which the app has not switched into yet.
 */
export async function createProject(
  workspaceId: string,
  name: string,
  description: string | null = null,
): Promise<ProjectSummary> {
  const res = await api.post('/v1/projects', { body: { workspaceId, name, description } })
  return res.project
}
