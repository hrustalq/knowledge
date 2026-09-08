import { defineStore } from 'pinia'
import type { ListWorkflowsResponse, WorkflowDefinitionInfo } from '@knowledge/contracts'
import { apiFetch, getProjectId, getWorkspaceId } from '@/lib/api'

/**
 * The workflow definitions available in the active project (docs/features/17).
 *
 * Held in a store rather than fetched per page because three unrelated places
 * ask the same question — the document rail's Run button, the /workflows
 * header, and the settings tab — and the answer is a handful of rows that
 * change only when an admin edits them.
 *
 * Scoped to the project for the same reason the glossary is: a definition may
 * be pinned to one project, and offering project A's chains on a page in
 * project B would start runs that write into the wrong place. `rescope()` is
 * therefore called from the projects store beside the glossary store's.
 */
export const useWorkflowsStore = defineStore('workflows', {
  state: () => ({
    workflows: [] as WorkflowDefinitionInfo[],
    loaded: false,
    /** In-flight fetch, so concurrent consumers share one request. */
    pending: null as Promise<void> | null,
  }),
  getters: {
    /** Only enabled definitions may be started; settings lists retired ones too. */
    runnable(state): WorkflowDefinitionInfo[] {
      return state.workflows.filter((w) => w.enabled)
    },
    byId(state): (id: string) => WorkflowDefinitionInfo | undefined {
      return (id: string) => state.workflows.find((w) => w.id === id)
    },
  },
  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      if (this.pending) return this.pending
      this.pending = this.fetchList().finally(() => (this.pending = null))
      return this.pending
    },
    async fetchList() {
      try {
        // No active project yet (the store resolves one asynchronously) means
        // "the whole workspace" — the same fallback the documents store uses.
        const projectId = getProjectId()
        const res = await apiFetch<ListWorkflowsResponse>(
          `/v1/workflows?workspaceId=${getWorkspaceId()}${projectId ? `&projectId=${projectId}` : ''}`,
        )
        this.workflows = res.workflows
      } catch {
        // A page must not die because the workflow roster is unavailable: the
        // Run affordance simply does not appear.
        this.workflows = []
      }
      this.loaded = true
    },
    async refresh() {
      this.loaded = false
      await this.ensureLoaded()
    },
    /**
     * Project switch: drop the roster immediately — offering the old project's
     * workflows under the new one is worse than offering none — then refetch
     * only if something was already using it.
     */
    async rescope() {
      const wanted = this.loaded
      this.workflows = []
      this.loaded = false
      if (wanted) await this.ensureLoaded()
    },
  },
})
