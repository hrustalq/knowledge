import { defineStore } from 'pinia'
import type { GlossaryTerm, ListGlossaryResponse } from '@knowledge/contracts'
import { apiFetch, getProjectId, getWorkspaceId } from '@/lib/api'

/**
 * The active project's vocabulary, held once for the whole app
 * (docs/features/14).
 *
 * Scoped to the project rather than the workspace because the terms are:
 * a page in project A must not be decorated with project B's definitions. The
 * roster therefore follows the project switcher — `rescope()` is called from
 * the projects store next to the documents store's, for the same reason.
 *
 * Every rendered page asks for it, so it must not become a request per page.
 * The roster is small, changes rarely, and is fetched lazily on the first
 * render that wants it — a workspace with no glossary therefore costs exactly
 * one empty response, and pages render immediately either way because linking
 * is a decoration applied after the markdown is already on screen.
 */
export const useGlossaryStore = defineStore('glossary', {
  state: () => ({
    terms: [] as GlossaryTerm[],
    loaded: false,
    /** In-flight fetch, so concurrent page renders share one request. */
    pending: null as Promise<void> | null,
  }),
  getters: {
    /** Only enabled terms are linked; the page lists retired ones too. */
    linkable(state): GlossaryTerm[] {
      return state.terms.filter((t) => t.enabled)
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
        const res = await apiFetch<ListGlossaryResponse>(
          `/v1/glossary?workspaceId=${getWorkspaceId()}${projectId ? `&projectId=${projectId}` : ''}`,
        )
        this.terms = res.terms
      } catch {
        // A glossary that cannot be loaded must never take a page down with
        // it: linking is an enhancement, and the prose is already rendered.
        this.terms = []
      }
      this.loaded = true
    },
    /** Called after a term is created, edited or removed on the glossary page. */
    async refresh() {
      this.loaded = false
      await this.ensureLoaded()
    },
    /**
     * The active project changed. Drop the vocabulary immediately — showing
     * the previous project's definitions under the new project's pages would
     * be worse than showing none — and refetch only if something was using it.
     */
    async rescope() {
      const wanted = this.loaded
      this.terms = []
      this.loaded = false
      if (wanted) await this.ensureLoaded()
    },
  },
})
