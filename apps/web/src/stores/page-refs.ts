import { defineStore } from 'pinia'
import type { DocumentTreeNode, DocumentTreeResponse } from '@knowledge/contracts'
import { apiFetch, getProjectId, getWorkspaceId } from '@/lib/api'
import { buildPageRefResolver, type PageRef, type PageRefResolver } from '@/lib/page-refs'

/**
 * Every page title in the workspace, for resolving references written as a
 * title (`lib/page-refs`).
 *
 * Deliberately **not** the documents store's `items`. That list is what the
 * pages view scrolls: paginated at `LIST_PAGE` and narrowed to the active
 * project, so resolving against it linked whichever references happened to fall
 * inside the loaded slice and left the rest dead — the worst possible outcome,
 * because a page whose links half work reads as a page with broken links rather
 * than as a page with a convention nobody has applied.
 *
 * The whole-tree endpoint with no `depth` and no `projectId` is one request for
 * the complete set, and it already exists. Titles are the only field kept: this
 * is an index, not a cache of documents, and it must not drift into being one.
 */
export const usePageRefsStore = defineStore('pageRefs', {
  state: () => ({
    pages: [] as PageRef[],
    loaded: false,
    /** In flight, so the several renderers on one screen make one request. */
    pending: null as Promise<void> | null,
  }),

  getters: {
    /**
     * Rebuilt whenever the roster changes; renderers watch this identity.
     *
     * Scoped to the active project only as a *tiebreak* — the roster stays
     * workspace-wide, because a reference across projects is still a reference,
     * and narrowing the index would turn "ambiguous" into "missing".
     */
    resolve(state): PageRefResolver {
      return buildPageRefResolver(state.pages, getProjectId())
    },
  },

  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      this.pending ??= this.load()
      await this.pending
    },

    async load() {
      try {
        const res = await apiFetch<DocumentTreeResponse>(
          `/v1/documents/tree?workspaceId=${getWorkspaceId()}`,
        )
        const flat: PageRef[] = []
        const walk = (nodes: DocumentTreeNode[]) => {
          for (const node of nodes) {
            flat.push({ documentId: node.documentId, title: node.title, projectId: node.projectId })
            walk(node.children)
          }
        }
        walk(res.roots)
        this.pages = flat
        this.loaded = true
      } finally {
        this.pending = null
      }
    },

    /**
     * Workspace-wide, so a project switch leaves it valid — but a new or
     * renamed page does not, and `document.updated` is what says so.
     */
    invalidate() {
      this.loaded = false
      this.pages = []
    },
  },
})
