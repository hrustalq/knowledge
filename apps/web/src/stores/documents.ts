import { defineStore } from 'pinia'
import type { DocumentSummary, ListDocumentsResponse } from '@knowledge/contracts'
import { apiFetch, DEMO_WORKSPACE_ID } from '@/lib/api'

export const useDocumentsStore = defineStore('documents', {
  state: () => ({
    items: [] as DocumentSummary[],
    loaded: false,
  }),
  actions: {
    async fetchList() {
      const res = await apiFetch<ListDocumentsResponse>(
        `/v1/documents?workspaceId=${DEMO_WORKSPACE_ID}&limit=50`,
      )
      this.items = res.items
      this.loaded = true
    },
  },
})
