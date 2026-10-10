// Feature 04 (docs/features/04): one EventSource per session; invalidates
// stores and toasts on revision lifecycle events.
import { defineStore } from 'pinia'
import { toast } from 'vue-sonner'
import type { ComposerTranslation } from 'vue-i18n'
import type { KnowledgeEvent, UrlTicketResponse } from '@knowledge/contracts'
import { ApiError, apiFetch, getToken, getWorkspaceId } from '@/lib/api'
import { useAssistantStore } from '@/stores/assistant'
import { useDocumentsStore } from '@/stores/documents'
import { useNotificationsStore } from '@/stores/notifications'

/** Reconnect backoff after the stream drops: 1 s, doubling, capped at 30 s. */
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

/**
 * The stream URL. EventSource cannot set headers, so in AUTH_MODE=api-key the
 * credential rides in ?token= — as a single-use, ~60 s `kt_` ticket minted with
 * the header credential, never the session token itself (#102). Without a
 * token (AUTH_MODE=none) the URL carries none.
 */
export async function eventsStreamUrl(workspaceId: string): Promise<string> {
  const url = `/api/v1/events?workspaceId=${encodeURIComponent(workspaceId)}`
  if (!getToken()) return url
  const { ticket } = await apiFetch<UrlTicketResponse>('/v1/auth/url-ticket', { method: 'POST' })
  return `${url}&token=${encodeURIComponent(ticket)}`
}

let source: EventSource | null = null
let retryMs = RETRY_MIN_MS

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
      this.connected = true
      void this.open(t)
    },
    /**
     * Open (or reopen) the stream with a fresh ticket. EventSource's own
     * auto-reconnect would replay the URL, and a ticket works once, so every
     * drop closes the source and comes back here instead.
     */
    async open(t: ComposerTranslation) {
      let url: string
      try {
        url = await eventsStreamUrl(getWorkspaceId())
      } catch (e) {
        // Signed out (or the session died): stop; the next sign-in connects again.
        if (e instanceof ApiError && e.status === 401) {
          this.connected = false
          return
        }
        this.retry(t)
        return
      }
      source?.close()
      source = new EventSource(url)
      source.onopen = () => {
        retryMs = RETRY_MIN_MS
      }
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
        } else if (event.type === 'notification.created') {
          // The badge is the only thing that always needs updating; the panel
          // and the page refetch through the live-cache rule when they are open.
          // Toasted only for a mention: everything else is news you will read
          // when you look, while being named is somebody waiting on you.
          void useNotificationsStore().refreshCount()
          if (event.reason === 'mention') {
            toast.info(t('notifications.toastMention', { name: event.title ?? t('notifications.untitled') }))
          }
        } else if (event.type === 'assistant.turn.finished' && event.subjectId) {
          // Reconciles a chat this tab stopped watching (Stop, or a dropped
          // connection) and mirrors turns taken in another tab.
          useAssistantStore().onTurnFinished(event.subjectId)
        } else if (event.type.startsWith('document.') || event.type.startsWith('merge-request.')) {
          void documents.invalidate()
        }
      }
      source.onerror = () => {
        source?.close()
        source = null
        this.retry(t)
      }
    },
    retry(t: ComposerTranslation) {
      const wait = retryMs
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
      setTimeout(() => void this.open(t), wait)
    },
  },
})
