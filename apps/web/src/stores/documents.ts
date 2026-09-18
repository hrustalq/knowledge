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
 * In-flight requests, per store instance and keyed by what they are fetching.
 *
 * Several components want the same thing on the same tick — the sidebar pane
 * and the breadcrumbs both want the trail for the page you just opened, and the
 * sidebar, the breadcrumbs and the page all want the tree — so the request is
 * shared rather than repeated, and callers that arrive late await the answer
 * that is already on its way.
 *
 * WeakMaps keyed by the store, not plain module-level maps: this module is
 * shared by every concurrent SSR render, and a bare map would hand one render a
 * promise that resolves into another request's store. They are not state,
 * because an in-flight request is a fact about this process — the server
 * serializes its store into the page, so a marker for a fetch the SSR render
 * started would otherwise reach the browser describing a request that is
 * already over and will never land.
 */
const revealing = new WeakMap<object, Map<string, Promise<DocumentTreeNode[]>>>()
const childFetches = new WeakMap<object, Map<string, Promise<void>>>()
const treeFetches = new WeakMap<object, Promise<void>>()

function inFlight<T>(registry: WeakMap<object, Map<string, T>>, store: object): Map<string, T> {
  let map = registry.get(store)
  if (!map) {
    map = new Map<string, T>()
    registry.set(store, map)
  }
  return map
}

function walk(nodes: DocumentTreeNode[], id: string): DocumentTreeNode | null {
  for (const node of nodes) {
    if (node.documentId === id) return node
    const hit = walk(node.children, id)
    if (hit) return hit
  }
  return null
}

/**
 * Whether our copy of the tree actually holds this node's children. `expanded`
 * alone cannot answer that: anything that replaces `tree` (a refetch, a scope
 * change) drops the children while rows that are open stay open, and a row
 * whose children were dropped has to be allowed to ask for them again.
 */
function childrenLoaded(nodes: DocumentTreeNode[], id: string): boolean {
  const node = walk(nodes, id)
  if (!node) return false
  return node.children.length > 0 || node.childCount === 0
}

/** The run a node belongs to: its parent's children, or the roots. */
function runOf(nodes: DocumentTreeNode[], parentId: string | null): DocumentTreeNode[] | null {
  if (parentId === null) return nodes
  return walk(nodes, parentId)?.children ?? null
}

/**
 * Lift a node out of the tree, reporting where it was so a failed move can put
 * it back exactly there rather than at the end of the run it came from.
 */
function detach(
  nodes: DocumentTreeNode[],
  id: string,
): { node: DocumentTreeNode; parentId: string | null; index: number } | null {
  type Found = { node: DocumentTreeNode; parentId: string | null; index: number }
  const search = (run: DocumentTreeNode[], parentId: string | null): Found | null => {
    const index = run.findIndex((n) => n.documentId === id)
    if (index !== -1) return { node: run.splice(index, 1)[0]!, parentId, index }
    for (const child of run) {
      const hit = search(child.children, child.documentId)
      if (hit) return hit
    }
    return null
  }
  const found = search(nodes, null)
  if (found && found.parentId !== null) {
    const parent = walk(nodes, found.parentId)
    // A parent that just lost its last child has to lose its chevron with it,
    // or the row stays expandable onto nothing.
    if (parent) parent.childCount = Math.max(0, parent.childCount - 1)
  }
  return found
}

/**
 * Put a node into a run above `beforeId` (or last). Returns false when the
 * destination is a collapsed branch we have not loaded: inserting there would
 * draw the moved page as that branch's only child.
 */
function attach(
  nodes: DocumentTreeNode[],
  node: DocumentTreeNode,
  parentId: string | null,
  beforeId: string | null,
): boolean {
  const parent = parentId === null ? null : walk(nodes, parentId)
  if (parentId !== null && !parent) return false
  if (parent) parent.childCount += 1
  if (parent && parent.children.length === 0 && parent.childCount > 1) return false
  const run = runOf(nodes, parentId)
  if (!run) return false
  const at = beforeId === null ? run.length : run.findIndex((n) => n.documentId === beforeId)
  node.parentId = parentId
  run.splice(at === -1 ? run.length : at, 0, node)
  return true
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
     * Feature 32. Ids whose move is in flight: the row and everything under it
     * dims and stops being draggable, while the rest of the tree stays live.
     * A list rather than one id because nothing stops a second drag starting
     * elsewhere in the tree before the first answers.
     */
    moving: [] as string[],
    /**
     * A drag is in progress somewhere. Remote invalidation waits for it — a
     * refetch mid-drag replaces `tree` wholesale and the row being dragged
     * stops existing under the cursor.
     */
    dragging: false,
    /** Set while `dragging` was true and something asked to invalidate. */
    invalidateQueued: false,

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
    async fetchTree(): Promise<void> {
      // The sidebar, the breadcrumbs and the page all ask for the tree, and on
      // a cold load they ask in the same tick — each seeing `treeLoaded` still
      // false. Without sharing the request the later answers land last and
      // reset `tree`/`expanded` *after* the open rows have already fetched
      // their children, stranding them open and empty.
      const pending = treeFetches.get(this)
      if (pending) return pending

      const job = (async () => {
        const res = await apiFetch<DocumentTreeResponse>(
          `/v1/documents/tree?workspaceId=${getWorkspaceId()}&depth=1${projectParam()}`,
        )
        this.tree = res.roots
        this.expanded = []
        this.expanding = []
        this.treeLoaded = true
      })().finally(() => {
        treeFetches.delete(this)
      })

      treeFetches.set(this, job)
      return job
    },

    /**
     * Children of one node, fetched once and then kept. Re-expanding a branch
     * you have already opened is free, which is what makes collapsing it a
     * cheap thing to do rather than something you learn to avoid.
     */
    async fetchChildren(parentId: string): Promise<void> {
      const pending = inFlight(childFetches, this)
      const running = pending.get(parentId)
      if (running) return running
      // Fetched *and* still here is what makes re-expanding free. Fetched but
      // gone — the tree was replaced under an open row — is a reason to ask
      // again, not a reason to sit on empty placeholders.
      if (this.expanded.includes(parentId) && childrenLoaded(this.tree, parentId)) return

      const job = (async () => {
        this.expanding = [...new Set([...this.expanding, parentId])]
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
          this.expanded = [...new Set([...this.expanded, parentId])]
        } finally {
          this.expanding = this.expanding.filter((id) => id !== parentId)
        }
      })().finally(() => {
        pending.delete(parentId)
      })

      pending.set(parentId, job)
      return job
    },

    /**
     * Materialize the trail down to a document so the tree can show where it
     * lives — the lazy equivalent of "it was already loaded". Ancestors come
     * from the API rather than from a client-side walk, because with a lazy
     * tree the page may not be in our copy at all.
     */
    async revealPath(documentId: string): Promise<DocumentTreeNode[]> {
      const pending = inFlight(revealing, this)
      const running = pending.get(documentId)
      if (running) return running

      const job = (async () => {
        if (!this.treeLoaded) await this.fetchTree()
        if (walk(this.tree, documentId)) return this.pathTo(documentId)

        const res = await apiFetch<DocumentAncestorsResponse>(`/v1/documents/${documentId}/ancestors`)
        // Top-down: each level has to exist before the next can be found in it.
        for (const ancestor of res.ancestors) await this.fetchChildren(ancestor.documentId)
        return this.pathTo(documentId)
      })().finally(() => pending.delete(documentId))

      pending.set(documentId, job)
      return job
    },

    /** Breadcrumb chain (root → … → document) from the loaded tree, or []. */
    /** The ids of one run, in the order the tree draws it. */
    siblingIdsOf(parentId: string | null): string[] {
      return (runOf(this.tree, parentId) ?? []).map((n) => n.documentId)
    },

    /** Is `candidateId` inside `rootId`'s subtree, as far as we have loaded it? */
    isDescendantOf(candidateId: string, rootId: string): boolean {
      const root = walk(this.tree, rootId)
      if (!root) return false
      const scan = (nodes: DocumentTreeNode[]): boolean =>
        nodes.some((n) => n.documentId === candidateId || scan(n.children))
      return scan(root.children)
    },

    /** A drag started; hold remote invalidation until it ends. */
    beginDrag() {
      this.dragging = true
    },

    /** A drag ended, whether it dropped or was cancelled. */
    endDrag() {
      this.dragging = false
      if (this.invalidateQueued) {
        this.invalidateQueued = false
        void this.invalidate()
      }
    },

    /**
     * Feature 32: move a page in the tree, optimistically.
     *
     * The row lands where it was dropped before the request goes out, and only
     * the moved subtree locks — a tree that froze whole would block navigating
     * away from a move you no longer care about. On failure the node goes back
     * to the exact index it left, which is why `detach` reports one.
     */
    async moveDocument(documentId: string, parentId: string | null, beforeId: string | null): Promise<void> {
      // Dropping a page back where it already sits is not a move. Worth
      // catching here: it is the single most common way a drag ends.
      const run = this.siblingIdsOf(parentId).filter((id) => id !== documentId)
      const currentIndex = this.siblingIdsOf(walk(this.tree, documentId)?.parentId ?? null).indexOf(documentId)
      const sameParent = (walk(this.tree, documentId)?.parentId ?? null) === parentId
      const targetIndex = beforeId === null ? run.length : run.indexOf(beforeId)
      if (sameParent && targetIndex === currentIndex) return

      // Dropping into a branch we have not opened yet: load it first, so the
      // page lands among real siblings instead of appearing to be the only one.
      if (parentId !== null && !childrenLoaded(this.tree, parentId)) {
        await this.fetchChildren(parentId)
      }

      const origin = detach(this.tree, documentId)
      if (!origin) return
      if (!attach(this.tree, origin.node, parentId, beforeId)) {
        // Destination turned out not to be drawable — put it straight back and
        // let a refetch settle it rather than leaving the page nowhere.
        attach(this.tree, origin.node, origin.parentId, this.siblingIdsOf(origin.parentId)[origin.index] ?? null)
        await this.invalidate()
        return
      }

      this.moving = [...this.moving, documentId]
      try {
        await apiFetch(`/v1/documents/${documentId}/move`, {
          method: 'POST',
          body: JSON.stringify({ parentId, beforeId }),
        })
      } catch (err) {
        // Back to the exact slot it came from. `siblingIdsOf` is re-read here
        // rather than captured, because the run may have shifted while we waited.
        detach(this.tree, documentId)
        const back = this.siblingIdsOf(origin.parentId)
        attach(this.tree, origin.node, origin.parentId, back[origin.index] ?? null)
        throw err
      } finally {
        this.moving = this.moving.filter((id) => id !== documentId)
      }
    },

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
      // A refetch replaces `tree` wholesale, so mid-drag it deletes the row
      // under the cursor and every rect the hit test is holding. Remember that
      // someone asked and answer it the moment the drag ends.
      if (this.dragging) {
        this.invalidateQueued = true
        return
      }
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
