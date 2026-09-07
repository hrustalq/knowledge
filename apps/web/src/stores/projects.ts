import { defineStore } from 'pinia'
import type { ListProjectsResponse, ProjectSummary } from '@knowledge/contracts'
import { apiFetch, getProjectId, getWorkspaceId, setActiveProject } from '@/lib/api'

/**
 * Workspace > Project > Document. The active project is remembered the same
 * way the active workspace is (localStorage + a `kn_proj` cookie so SSR can
 * render the right tree), but it is resolved against the roster on load: a
 * stored id that no longer exists falls back to the first project.
 */
export const useProjectsStore = defineStore('projects', {
  state: () => ({
    items: [] as ProjectSummary[],
    loaded: false,
    activeId: getProjectId() as string | null,
  }),
  getters: {
    active(state): ProjectSummary | null {
      return state.items.find((p) => p.projectId === state.activeId) ?? null
    },
    activeName(): string | null {
      return this.active?.name ?? null
    },
  },
  actions: {
    async fetchList() {
      const res = await apiFetch<ListProjectsResponse>(`/v1/projects?workspaceId=${getWorkspaceId()}`)
      this.items = res.projects
      this.loaded = true

      const stillExists = this.activeId && res.projects.some((p) => p.projectId === this.activeId)
      if (!stillExists) {
        const fallback = res.projects[0]?.projectId ?? null
        this.activeId = fallback
        setActiveProject(fallback)
      }
    },
    /**
     * Full reload, for the same reason switching workspace does one: the page
     * tree, query cache and live subscription are all scoped to the selection.
     */
    switchProject(projectId: string) {
      if (projectId === this.activeId) return
      setActiveProject(projectId)
      window.location.assign('/documents')
    },
  },
})
