import { defineStore } from 'pinia'
import type { GlossaryTerm, ListGlossaryResponse } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

/**
 * The workspace's vocabulary, held once for the whole app (docs/features/14).
 *
 * Terms belong to a project, and a page in project A must never be decorated
 * with project B's definitions. The roster is still loaded for the whole
 * workspace: the page being read decides which project's terms apply
 * (`DocumentCanvas` filters on the page's `projectId`), and a page reached from
 * search or a link is often not in the project the switcher shows (#702). One
 * request covers every page in the workspace, so a project switch refetches
 * nothing; a workspace switch reloads the app.
 *
 * Every rendered page asks for it, so it must not become a request per page.
 * The roster is small, changes rarely, and is fetched lazily on the first
 * render that wants it — a workspace with no glossary therefore costs exactly
 * one empty response, and pages render immediately either way because linking
 * is a decoration applied after the markdown is already on screen.
 *
 * ponytail: whole-workspace roster, key it by project if a workspace's
 * glossary grows to thousands of terms.
 */
export const useGlossaryStore = defineStore('glossary', {
  state: () => ({
    terms: [] as GlossaryTerm[],
    loaded: false,
    /** In-flight fetch, so concurrent page renders share one request. */
    pending: null as Promise<void> | null,
  }),
  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      if (this.pending) return this.pending
      this.pending = this.fetchList().finally(() => (this.pending = null))
      return this.pending
    },
    async fetchList(fresh = false) {
      try {
        await bindStoreQuery<ListGlossaryResponse>(
          this,
          'list',
          this.queryClient,
          apiQueryOptions('/v1/glossary', { query: { workspaceId: getWorkspaceId() } }),
          (res) => {
            this.terms = res.terms
          },
          { fresh },
        )
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
      this.pending = this.fetchList(true).finally(() => (this.pending = null))
      await this.pending
    },
  },
})
