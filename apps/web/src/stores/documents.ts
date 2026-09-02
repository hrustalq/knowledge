import { defineStore } from 'pinia'
import type { DocumentSummary, DocumentTreeNode, DocumentTreeResponse, ListDocumentsResponse } from '@knowledge/contracts'
import { apiFetch, DEMO_WORKSPACE_ID } from '@/lib/api'

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
        `/v1/documents?workspaceId=${DEMO_WORKSPACE_ID}&limit=100`,
      )
      this.items = res.items
      this.loaded = true
    },
    async fetchTree() {
      const res = await apiFetch<DocumentTreeResponse>(
        `/v1/documents/tree?workspaceId=${DEMO_WORKSPACE_ID}`,
      )
      this.tree = res.roots
      this.treeLoaded = true
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
