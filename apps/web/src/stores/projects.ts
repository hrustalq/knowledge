import { defineStore } from 'pinia'
import type { ListProjectsResponse, ProjectSummary } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { getProjectId, getWorkspaceId, setActiveProject } from '@/shared/api/api'
import { useDocumentsStore } from '@/stores/documents'
import { useGlossaryStore } from '@/modules/documents/model/glossary.store'
import { useWorkflowsStore } from '@/modules/workflows/model/workflows.store'
import { useSidebarNavStore } from '@/stores/sidebar-nav'

/**
 * A project-scoped store outside stores/ registers its `use…Store` here, at
 * module load, and switchProject rescopes it with the rest
 * (docs/architecture/11): a cross-cutting store never imports a feature. The
 * definition is registered, not an instance, so this is the same for every
 * request a server renders — and a store whose module never loaded has no
 * instance to rescope.
 */
const projectScoped = new Set<() => { rescope(): Promise<void> }>()
export function registerProjectScoped(useStore: () => { rescope(): Promise<void> }): void {
  projectScoped.add(useStore)
}

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
    /** `fresh` after a write the roster has not heard about through the live feed. */
    fetchList(opts: { fresh?: boolean } = {}): Promise<void> {
      // The rail, the breadcrumbs and the page ask on mount in the same tick;
      // the query cache joins them onto one request (#279).
      return bindStoreQuery<ListProjectsResponse>(
        this,
        'list',
        this.queryClient,
        apiQueryOptions('/v1/projects', { query: { workspaceId: getWorkspaceId() } }),
        (res) => {
          this.items = res.projects
          this.loaded = true

          const stillExists = this.activeId && res.projects.some((p) => p.projectId === this.activeId)
          if (!stillExists) {
            const fallback = res.projects[0]?.projectId ?? null
            this.activeId = fallback
            setActiveProject(fallback)
          }
        },
        opts,
      )
    },
    /**
     * Switch scope in place. Unlike a workspace switch this does *not* reload
     * the app: nothing project-scoped is cached outside the documents store
     * (search sends its filters explicitly, the live subscription is keyed on
     * the workspace), and a reload would tear down the sidebar mid-animation.
     *
     * Callers own navigation, because the right answer depends on where they
     * are: a document route now points outside the new scope, a settings route
     * does not care. The rail always ends up inside the project you just chose.
     */
    async switchProject(projectId: string) {
      if (projectId === this.activeId) return
      this.activeId = projectId
      setActiveProject(projectId)
      useSidebarNavStore().openPages()
      // The glossary (14), the workflow roster (17) and the templates (#69)
      // are project-scoped too, so they rescope alongside the page tree rather
      // than decorating the new project's pages with the previous one's
      // vocabulary, or offering chains and templates that would write into the
      // project you just left.
      await Promise.all([
        useDocumentsStore().rescope(),
        useGlossaryStore().rescope(),
        useWorkflowsStore().rescope(),
        ...[...projectScoped].map((useStore) => useStore().rescope()),
      ])
    },
  },
})
