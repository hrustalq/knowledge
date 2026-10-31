// Feature 04 (docs/features/04): one EventSource per session; invalidates
// stores and toasts on revision lifecycle events. A module that reacts to an
// event of its own watches `lastEvent` (NotificationBell does), and a store
// outside stores/ subscribes with onKnowledgeEvent, so this store never imports
// a module or an entity (docs/architecture/11).
import { defineStore } from 'pinia'
import { toast } from 'vue-sonner'
import type { ComposerTranslation } from 'vue-i18n'
import type { KnowledgeEvent } from '@knowledge/contracts'
import { api, isApiRequestError } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { useDocumentsStore } from '@/stores/documents'

/** Reconnect backoff after the stream drops: 1 s, doubling, capped at 30 s. */
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

/**
 * The stream URL, with a single-use, ~60 s `kt_` ticket in ?token= (#102).
 * The cookie alone would authenticate this same-origin GET (#650), but minting
 * first is what tells a dead session (401: stop) from a dropped stream (retry):
 * EventSource never shows its status. In AUTH_MODE=none the ticket is ignored.
 */
export async function eventsStreamUrl(workspaceId: string): Promise<string> {
  const { ticket } = await api.post('/v1/auth/url-ticket')
  return `/api/v1/events?workspaceId=${encodeURIComponent(workspaceId)}&token=${encodeURIComponent(ticket)}`
}

/**
 * Stores outside stores/ that react to an event: each subscribes once at
 * module load, the way registerProjectScoped works for a project switch.
 */
const listeners = new Set<(event: KnowledgeEvent) => void>()
export function onKnowledgeEvent(listener: (event: KnowledgeEvent) => void): void {
  listeners.add(listener)
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
        if (isApiRequestError(e) && e.status === 401) {
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
        for (const listener of listeners) listener(event)
        const documents = useDocumentsStore()
        if (event.type === 'revision.indexed') {
          void documents.invalidate()
          toast.success(t('activity.indexed', { name: event.title ?? event.documentId }))
        } else if (event.type === 'revision.failed') {
          toast.error(t('activity.indexingFailed', { name: event.title ?? event.documentId }))
        } else if (event.type === 'revision.dependent-reindex') {
          toast.info(t('activity.reindexingDependent', { name: event.title ?? event.documentId }))
        } else if (event.type === 'acl.changed') {
          // A restriction or grant moved (#76): the tree and lists may now
          // show more or less. Pages watching `lastEvent` re-read themselves.
          void documents.invalidate()
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
