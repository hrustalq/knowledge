// Feature 04 (docs/features/04): one EventSource per session; invalidates
// stores and toasts on revision lifecycle events.
import { defineStore } from 'pinia'
import { toast } from 'vue-sonner'
import type { ComposerTranslation } from 'vue-i18n'
import type { KnowledgeEvent } from '@knowledge/contracts'
import { getToken, getWorkspaceId } from '@/lib/api'
import { useAssistantStore } from '@/stores/assistant'
import { useDocumentsStore } from '@/stores/documents'

export const useEventsStore = defineStore('events', {
  state: () => ({
    connected: false,
    lastEvent: null as KnowledgeEvent | null,
    /** Bumped on every event — pages can watch it to refresh themselves. */
    revision: 0,
  }),
  actions: {
    connect(t: ComposerTranslation) {
      if (this.connected || import.meta.env.SSR) return
      // AUTH_MODE=api-key: EventSource cannot set headers — the API accepts ?token=.
      const token = getToken()
      const source = new EventSource(
        `/api/v1/events?workspaceId=${getWorkspaceId()}${token ? `&token=${token}` : ''}`,
      )
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
          toast.success(t('activity.indexed', { name: event.title ?? event.documentId }))
        } else if (event.type === 'revision.failed') {
          toast.error(t('activity.indexingFailed', { name: event.title ?? event.documentId }))
        } else if (event.type === 'revision.dependent-reindex') {
          toast.info(t('activity.reindexingDependent', { name: event.title ?? event.documentId }))
        } else if (event.type === 'assistant.turn.finished' && event.subjectId) {
          // Reconciles a chat this tab stopped watching (Stop, or a dropped
          // connection) and mirrors turns taken in another tab.
          useAssistantStore().onTurnFinished(event.subjectId)
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
