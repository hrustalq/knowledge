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

/**
 * Is there anyone left to invite to this workspace?
 *
 * Asked *before* offering the invite step, because a step whose only control
 * is a disabled empty picker is a dead end, not a choice — and in a workspace
 * where everyone is already a member that is the normal case, not an edge one.
 * Failures answer "no": the step is optional, so it is not worth an error.
 */
export async function workspaceHasCandidates(workspaceId: string): Promise<boolean> {
  try {
    const res = await api.get('/v1/workspaces/{id}/candidates', {
      path: { id: workspaceId },
      query: { limit: 1 },
    })
    return res.candidates.length > 0
  } catch {
    return false
  }
}
