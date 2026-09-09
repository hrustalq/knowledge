import { defineStore } from 'pinia'
import type {
  DocumentAncestorsResponse,
  DocumentCategory,
  DocumentSummary,
  DocumentTreeNode,
  DocumentTreeResponse,
  ListDocumentsResponse,
  WorkspaceGraphResponse,
} from '@knowledge/contracts'
import { apiFetch, getProjectId, getWorkspaceId } from '@/lib/api'

/** `&projectId=` when a project is active; without it the API spans the workspace. */
function projectParam(): string {
  const projectId = getProjectId()
  return projectId ? `&projectId=${projectId}` : ''
}

export interface DocumentFilters {
  categories: DocumentCategory[]
  projectIds: string[]
  /** Tag entity keys, e.g. 'tag:security'. */
  tags: string[]
}

export const EMPTY_FILTERS: DocumentFilters = { categories: [], projectIds: [], tags: [] }

/**
 * Rows per request. The list scrolls forever, so this is a fetch size, not a
 * page size — big enough that scrolling rarely outruns it, small enough that
 * the first screen arrives immediately.
 */
export const LIST_PAGE = 50

/**
 * In-flight trail resolutions, keyed by document id.
 *
 * Both the sidebar pane and the breadcrumbs want the trail for the page you
 * just opened, and they mount together. Without this they would each fetch the
 * ancestor chain for the same document on every navigation.
 */
const revealing = new Map<string, Promise<DocumentTreeNode[]>>()

function walk(nodes: DocumentTreeNode[], id: string): DocumentTreeNode | null {
  for (const node of nodes) {
    if (node.documentId === id) return node
    const hit = walk(node.children, id)
    if (hit) return hit
  }
  return null
}

export const useDocumentsStore = defineStore('documents', {
  state: () => ({
    /** Everything loaded so far — the list appends as it is scrolled. */
    items: [] as DocumentSummary[],
    loaded: false,
    listBusy: false,
    filters: { ...EMPTY_FILTERS } as DocumentFilters,
    /** Pointer to the next batch; null once the end has been reached. */
    nextCursor: null as string | null,

    /**
     * The page tree, loaded a level at a time. `children` is only populated for
     * nodes someone has expanded; `childCount` is what tells a collapsed row it
     * has a chevron.
     */
    tree: [] as DocumentTreeNode[],
    treeLoaded: false,
    /** Node ids whose children are in flight, so a row can show it is working. */
    expanding: [] as string[],
    /** Node ids whose children have been fetched — empty branches included. */
    expanded: [] as string[],

    /**
     * The whole scope as one relation graph, for the pages landing. Kept beside
     * the tree rather than fetched by the page so switching Graph -> Tree ->
     * Graph does not re-request it, and so `rescope`/`invalidate` cannot forget
     * one of the three views.
     */
    graph: null as WorkspaceGraphResponse | null,
    graphLoaded: false,
  }),

  getters: {
    activeFilterCount: (s) => s.filters.categories.length + s.filters.projectIds.length + s.filters.tags.length,
    hasMore: (s) => !s.loaded || s.nextCursor !== null,
  },

  actions: {
    /* ------------------------------------------------------------ the list */

    /**
     * One batch of the list.
     *
     * `reset` starts over — a filter change invalidates every cursor already
     * handed out — while the default appends, which is what the virtualized
     * list asks for as the reader nears the end. Concurrent calls are ignored
     * rather than queued: a scroll can fire the request several times before
     * the first returns, and appending the same batch twice is worse than
     * fetching it a moment later.
     */
    async fetchList(opts: { reset?: boolean } = {}) {
      if (this.listBusy) return
      if (!opts.reset && this.loaded && this.nextCursor === null) return
      this.listBusy = true
      try {
        const params = new URLSearchParams({
          workspaceId: getWorkspaceId(),
          limit: String(LIST_PAGE),
        })
        const projectId = getProjectId()
        // An explicit project facet outranks the ambient scope: the reader
        // asked for those projects, not for the one the switcher happens to
        // be parked on.
        if (this.filters.projectIds.length) params.set('projectIds', this.filters.projectIds.join(','))
        else if (projectId) params.set('projectId', projectId)
        if (this.filters.categories.length) params.set('categories', this.filters.categories.join(','))
        if (this.filters.tags.length) params.set('tags', this.filters.tags.join(','))
        if (!opts.reset && this.nextCursor) params.set('cursor', this.nextCursor)

        const res = await apiFetch<ListDocumentsResponse>(`/v1/documents?${params}`)
        this.items = opts.reset ? res.items : [...this.items, ...res.items]
        this.nextCursor = res.nextCursor
        this.loaded = true
      } finally {
        this.listBusy = false
      }
    },

    /** The next batch, if there is one and nothing is already in flight. */
    async loadMore() {
      if (!this.loaded || this.nextCursor === null || this.listBusy) return
      await this.fetchList()
    },

    async setFilters(filters: DocumentFilters) {
      this.filters = filters
      this.nextCursor = null
      // A filter change must not append onto the previous filter's rows, and
      // `fetchList` refuses to run while one is in flight — so clear the guard.
      this.listBusy = false
      await this.fetchList({ reset: true })
    },

    /* ------------------------------------------------------------- the tree */

    /**
     * Load the top level only. The whole tree used to arrive on every route,
     * because the sidebar mounts everywhere — a few hundred rows to draw the
     * six that are visible.
     */
    async fetchTree() {
      const res = await apiFetch<DocumentTreeResponse>(
        `/v1/documents/tree?workspaceId=${getWorkspaceId()}&depth=1${projectParam()}`,
      )
      this.tree = res.roots
      this.expanded = []
      this.expanding = []
      this.treeLoaded = true
    },

    /**
     * Children of one node, fetched once and then kept. Re-expanding a branch
     * you have already opened is free, which is what makes collapsing it a
     * cheap thing to do rather than something you learn to avoid.
     */
    async fetchChildren(parentId: string): Promise<void> {
      if (this.expanded.includes(parentId) || this.expanding.includes(parentId)) return
      this.expanding = [...this.expanding, parentId]
      try {
        const res = await apiFetch<DocumentTreeResponse>(
          `/v1/documents/tree?workspaceId=${getWorkspaceId()}&depth=1&parentId=${parentId}${projectParam()}`,
        )
        const node = walk(this.tree, parentId)
        if (node) {
          node.children = res.roots
          // The server just counted them; trust that over a stale count.
          node.childCount = res.roots.length
        }
        this.expanded = [...this.expanded, parentId]
      } finally {
        this.expanding = this.expanding.filter((id) => id !== parentId)
      }
    },

    /**
     * Materialize the trail down to a document so the tree can show where it
     * lives — the lazy equivalent of "it was already loaded". Ancestors come
     * from the API rather than from a client-side walk, because with a lazy
     * tree the page may not be in our copy at all.
     */
    async revealPath(documentId: string): Promise<DocumentTreeNode[]> {
      const inFlight = revealing.get(documentId)
      if (inFlight) return inFlight

      const job = (async () => {
        if (!this.treeLoaded) await this.fetchTree()
        if (walk(this.tree, documentId)) return this.pathTo(documentId)

        const res = await apiFetch<DocumentAncestorsResponse>(`/v1/documents/${documentId}/ancestors`)
        // Top-down: each level has to exist before the next can be found in it.
        for (const ancestor of res.ancestors) await this.fetchChildren(ancestor.documentId)
        return this.pathTo(documentId)
      })().finally(() => revealing.delete(documentId))

      revealing.set(documentId, job)
      return job
    },

    /** Breadcrumb chain (root → … → document) from the loaded tree, or []. */
    pathTo(documentId: string): DocumentTreeNode[] {
      const find = (nodes: DocumentTreeNode[], trail: DocumentTreeNode[]): DocumentTreeNode[] | null => {
        for (const node of nodes) {
          const next = [...trail, node]
          if (node.documentId === documentId) return next
          const hit = find(node.children, next)
          if (hit) return hit
        }
        return null
      }
      return find(this.tree, []) ?? []
    },

    /* --------------------------------------------------------------- graph */

    async fetchGraph() {
      const res = await apiFetch<WorkspaceGraphResponse>(
        `/v1/documents/graph?workspaceId=${getWorkspaceId()}${projectParam()}`,
      )
      this.graph = res
      this.graphLoaded = true
    },

    /* ---------------------------------------------------------- lifecycle */

    /**
     * The active project changed: drop the scoped data and refetch whatever was
     * actually in use. Clearing first is deliberate — the sidebar's pages pane
     * shows its skeletons while the new tree loads instead of holding the old
     * project's pages under the new project's name for a beat.
     */
    async rescope() {
      const wantList = this.loaded
      const wantTree = this.treeLoaded
      const wantGraph = this.graphLoaded
      this.items = []
      this.loaded = false
      this.nextCursor = null
      this.listBusy = false
      this.tree = []
      this.treeLoaded = false
      this.expanded = []
      this.expanding = []
      this.graph = null
      this.graphLoaded = false
      const jobs: Promise<void>[] = []
      if (wantList) jobs.push(this.fetchList({ reset: true }))
      if (wantTree) jobs.push(this.fetchTree())
      if (wantGraph) jobs.push(this.fetchGraph())
      await Promise.all(jobs)
    },

    /**
     * Feature 04: called by the events store when the workspace changed
     * remotely. Expanded branches are refetched too — a page created under an
     * open branch has to appear there, not only in the list.
     */
    async invalidate() {
      const jobs: Promise<void>[] = []
      // Reset rather than append: a remote change can insert a row anywhere,
      // and the cursor we are holding points into the old ordering.
      if (this.loaded) {
        this.listBusy = false
        this.nextCursor = null
        jobs.push(this.fetchList({ reset: true }))
      }
      if (this.graphLoaded) jobs.push(this.fetchGraph())
      if (this.treeLoaded) {
        const reopen = [...this.expanded]
        jobs.push(
          this.fetchTree().then(async () => {
            for (const id of reopen) {
              if (walk(this.tree, id)) await this.fetchChildren(id)
            }
          }),
        )
      }
      await Promise.all(jobs)
    },
  },
})
