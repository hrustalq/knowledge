// Feature 04 (docs/features/04): one EventSource per session; invalidates
// stores and toasts on revision lifecycle events.
import { defineStore } from 'pinia'
import { toast } from 'vue-sonner'
import type { KnowledgeEvent } from '@knowledge/contracts'
import { DEMO_WORKSPACE_ID } from '@/lib/api'
import { useDocumentsStore } from '@/stores/documents'

export const useEventsStore = defineStore('events', {
  state: () => ({
    connected: false,
    lastEvent: null as KnowledgeEvent | null,
    /** Bumped on every event — pages can watch it to refresh themselves. */
    revision: 0,
  }),
  actions: {
    connect() {
      if (this.connected || import.meta.env.SSR) return
      const source = new EventSource(`/api/v1/events?workspaceId=${DEMO_WORKSPACE_ID}`)
      source.onmessage = (msg) => {
        let event: KnowledgeEvent
        try {
          event = JSON.parse(msg.data as string) as KnowledgeEvent
        } catch {
          return
        }
        if (event.type === 'ping') return
        this.lastEvent = event
        this.revision++
        const documents = useDocumentsStore()
        if (event.type === 'revision.indexed') {
          void documents.invalidate()
          toast.success(`Indexed: ${event.title ?? event.documentId}`)
        } else if (event.type === 'revision.failed') {
          toast.error(`Indexing failed: ${event.title ?? event.documentId}`)
        } else if (event.type === 'revision.dependent-reindex') {
          toast.info(`Re-indexing dependent: ${event.title ?? event.documentId}`)
        } else if (event.type.startsWith('document.') || event.type.startsWith('merge-request.')) {
          void documents.invalidate()
        }
      }
      source.onerror = () => {
        /* EventSource auto-reconnects; nothing to do */
      }
      this.connected = true
    },
  },
})
