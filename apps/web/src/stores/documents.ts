import { defineStore } from 'pinia'
import type { DocumentSummary, DocumentTreeNode, DocumentTreeResponse, ListDocumentsResponse } from '@knowledge/contracts'
import { apiFetch, getProjectId, getWorkspaceId } from '@/lib/api'

/** `&projectId=` when a project is active; without it the API spans the workspace. */
function projectParam(): string {
  const projectId = getProjectId()
  return projectId ? `&projectId=${projectId}` : ''
}

export const useDocumentsStore = defineStore('documents', {
  state: () => ({
    items: [] as DocumentSummary[],
    loaded: false,
    tree: [] as DocumentTreeNode[],
    treeLoaded: false,
  }),
  actions: {
    async fetchList() {
      const res = await apiFetch<ListDocumentsResponse>(
        `/v1/documents?workspaceId=${getWorkspaceId()}&limit=100${projectParam()}`,
      )
      this.items = res.items
      this.loaded = true
    },
    async fetchTree() {
      const res = await apiFetch<DocumentTreeResponse>(
        `/v1/documents/tree?workspaceId=${getWorkspaceId()}${projectParam()}`,
      )
      this.tree = res.roots
      this.treeLoaded = true
    },
    /** Breadcrumb chain (root → … → document) from the loaded tree, or []. */
    pathTo(documentId: string): DocumentTreeNode[] {
      const walk = (nodes: DocumentTreeNode[], trail: DocumentTreeNode[]): DocumentTreeNode[] | null => {
        for (const node of nodes) {
          const next = [...trail, node]
          if (node.documentId === documentId) return next
          const hit = walk(node.children, next)
          if (hit) return hit
        }
        return null
      }
      return walk(this.tree, []) ?? []
    },
    /**
     * The active project changed: drop the scoped data and refetch whatever was
     * actually in use. Clearing first is deliberate — the sidebar's pages pane
     * shows its skeletons while the new tree loads instead of holding the old
     * project's pages under the new project's name for a beat.
     */
    async rescope() {
      const wantList = this.loaded
      const wantTree = this.treeLoaded
      this.items = []
      this.loaded = false
      this.tree = []
      this.treeLoaded = false
      const jobs: Promise<void>[] = []
      if (wantList) jobs.push(this.fetchList())
      if (wantTree) jobs.push(this.fetchTree())
      await Promise.all(jobs)
    },
    /** Feature 04: called by the events store when the workspace changed remotely. */
    async invalidate() {
      const jobs: Promise<void>[] = []
      if (this.loaded) jobs.push(this.fetchList())
      if (this.treeLoaded) jobs.push(this.fetchTree())
      await Promise.all(jobs)
    },
  },
})
