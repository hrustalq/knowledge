// Chat pane (docs/features/09 follow-up): a persisted multi-turn thread per
// workspace/document, mirroring stores/documents.ts and stores/events.ts in
// shape. The sidebar derives "documents touched" from message.sources rather
// than parsing chat text — see assistant-threads.service.ts on the API side.
//
// A turn streams by default (POST .../messages/stream) so the pane can show
// the model working instead of a spinner. `live` holds everything that only
// exists mid-turn — the answer as it arrives plus the reasoning trail behind
// it — and is thrown away when the persisted message lands, which is the one
// authoritative copy.
import { markRaw } from 'vue'
import { defineStore } from 'pinia'
import type {
  AssistantAskSource,
  AssistantChatAttachment,
  AssistantChatMode,
  AssistantMessageInfo,
  AssistantPrompt,
  AssistantThreadSummary,
  AssistantToolCall,
  AssistantUiBlock,
  CreateAssistantThreadResponse,
  GetAssistantThreadResponse,
  ListAssistantThreadsResponse,
  TruncateAssistantThreadResponse,
  UpdateAssistantThreadResponse,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { streamAssistantTurn } from '@/lib/assistant-stream'

const PAGE_SIZE = 40
/** How long to wait for `assistant.turn.finished` after a Stop before re-reading anyway. */
const STOP_SETTLE_FALLBACK_MS = 2_500

/** One completed leg of the model's work: what it said, then what it reached for. */
export interface LiveStep {
  text: string
  toolCalls: AssistantToolCall[]
}

/** Everything that exists only while a turn is in flight. */
export interface LiveTurn {
  /** 'thinking' before the first token of the final answer, 'responding' after. */
  phase: 'thinking' | 'responding'
  /** The answer so far — replaced wholesale by the persisted message when the turn lands. */
  text: string
  /** Closed reasoning legs, oldest first. */
  steps: LiveStep[]
  /** Tools running right now, in call order. */
  running: string[]
  /** Tools that have finished in the current leg. */
  finished: AssistantToolCall[]
  uiBlocks: AssistantUiBlock[]
  sources: AssistantAskSource[]
  /** A question the turn is ending on — rendered as soon as it lands, answerable once the turn is done. */
  prompt: AssistantPrompt | null
  /** Stopped by the reader. The text so far stays on screen, frozen, until the
   * server's copy of the same partial reply replaces it. */
  stopped: boolean
}

function emptyTurn(): LiveTurn {
  return {
    phase: 'thinking',
    text: '',
    steps: [],
    running: [],
    finished: [],
    uiBlocks: [],
    sources: [],
    prompt: null,
    stopped: false,
  }
}

export const useAssistantStore = defineStore('assistant', {
  state: () => ({
    threads: [] as AssistantThreadSummary[],
    threadsLoaded: false,
    threadsLoading: false,
    /** Null when the roster is fully loaded; otherwise the keyset cursor for the next page. */
    nextCursor: null as string | null,
    search: '',
    activeThread: null as AssistantThreadSummary | null,
    messages: [] as AssistantMessageInfo[],
    messagesLoading: false,
    sending: false,
    /** Present only while a turn is in flight. */
    live: null as LiveTurn | null,
    /** markRaw'd: fetch brand-checks the signal, so it must not be a reactive proxy. */
    abort: null as AbortController | null,
    /** Fallback re-read after a Stop, for when the live event bus is not connected. */
    settleTimer: null as number | null,
    error: null as string | null,
  }),
  getters: {
    /** Documents referenced or written to in this thread, most recent first, deduped. */
    documentsTouched(state): AssistantAskSource[] {
      const byId = new Map<string, AssistantAskSource>()
      for (const m of state.messages) {
        for (const s of m.sources) byId.set(s.documentId, s)
      }
      // Mid-turn citations belong here too, otherwise the pane sits empty
      // through the exact moment the assistant is finding things.
      for (const s of state.live?.sources ?? []) byId.set(s.documentId, s)
      return [...byId.values()].reverse()
    },
    /** This thread's own sent messages, oldest first — the composer walks this backwards on ArrowUp
     * (shell-style recall), so a stale placeholder from a failed send never shows up in the list. */
    sentHistory(state): string[] {
      return state.messages.filter((m) => m.role === 'user' && !m.id.startsWith('pending-')).map((m) => m.content)
    },
  },
  actions: {
    // ---- Roster -----------------------------------------------------------

    /** Loads the first page, replacing whatever is there (search change, workspace switch, reload). */
    async fetchThreads() {
      this.threadsLoading = true
      try {
        const res = await this.loadPage()
        this.threads = res.threads
        this.nextCursor = res.nextCursor
        this.threadsLoaded = true
      } finally {
        this.threadsLoading = false
      }
    },

    async loadMoreThreads() {
      if (!this.nextCursor || this.threadsLoading) return
      this.threadsLoading = true
      try {
        const res = await this.loadPage(this.nextCursor)
        // Concurrent activity can re-order the roster between pages; drop any
        // id already on screen rather than rendering a duplicate row.
        const seen = new Set(this.threads.map((t) => t.id))
        this.threads.push(...res.threads.filter((t) => !seen.has(t.id)))
        this.nextCursor = res.nextCursor
      } finally {
        this.threadsLoading = false
      }
    },

    async setSearch(query: string) {
      if (this.search === query) return
      this.search = query
      await this.fetchThreads()
    },

    loadPage(cursor?: string): Promise<ListAssistantThreadsResponse> {
      const params = new URLSearchParams({ workspaceId: getWorkspaceId(), limit: String(PAGE_SIZE) })
      if (cursor) params.set('cursor', cursor)
      if (this.search.trim()) params.set('search', this.search.trim())
      return apiFetch<ListAssistantThreadsResponse>(`/v1/assistant/threads?${params}`)
    },

    // ---- Thread lifecycle -------------------------------------------------

    /** Opens the most recently active thread for this workspace, creating one if none exists. */
    async openOrCreateThread(documentId?: string) {
      if (!this.threadsLoaded) await this.fetchThreads()
      const existing = this.threads[0]
      if (existing) return this.openThread(existing.id)
      return this.newThread(documentId)
    },

    async newThread(documentId?: string) {
      const res = await apiFetch<CreateAssistantThreadResponse>('/v1/assistant/threads', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: getWorkspaceId(), ...(documentId ? { documentId } : {}) }),
      })
      this.threads.unshift(res.thread)
      this.activeThread = res.thread
      this.messages = []
      this.live = null
      this.error = null
      return res.thread
    },

    async openThread(threadId: string) {
      if (this.activeThread?.id === threadId) return
      this.messagesLoading = true
      this.error = null
      try {
        const res = await apiFetch<GetAssistantThreadResponse>(`/v1/assistant/threads/${threadId}`)
        this.activeThread = res.thread
        this.messages = res.messages
        this.live = null
        this.syncSummary(res.thread)
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.messagesLoading = false
      }
    },

    async renameThread(threadId: string, title: string | null) {
      const trimmed = title?.trim() || null
      const res = await apiFetch<UpdateAssistantThreadResponse>(`/v1/assistant/threads/${threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      })
      this.syncSummary(res.thread)
      if (this.activeThread?.id === threadId) this.activeThread = res.thread
    },

    /**
     * Pins this thread to a provider profile (docs/features/12), or clears the
     * pin so it follows whatever the workspace routes chat at. Thread-level
     * rather than per-message: switching model mid-conversation is a decision
     * about the conversation, and the next turn should honour it without the
     * sender having to re-pick.
     */
    async setThreadProvider(threadId: string, providerId: string | null) {
      const res = await apiFetch<UpdateAssistantThreadResponse>(`/v1/assistant/threads/${threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ providerId }),
      })
      this.syncSummary(res.thread)
      if (this.activeThread?.id === threadId) this.activeThread = res.thread
    },

    /** Deletes the thread; if it was open, falls back to the next one in the roster. */
    async deleteThread(threadId: string) {
      await apiFetch(`/v1/assistant/threads/${threadId}`, { method: 'DELETE' })
      const index = this.threads.findIndex((t) => t.id === threadId)
      if (index >= 0) this.threads.splice(index, 1)
      if (this.activeThread?.id !== threadId) return
      this.activeThread = null
      this.messages = []
      this.live = null
      const fallback = this.threads[Math.min(index, this.threads.length - 1)]
      if (fallback) await this.openThread(fallback.id)
      else await this.newThread()
    },

    // ---- Rewinding --------------------------------------------------------

    /**
     * Drops a message and everything after it. The primitive under both
     * per-message controls: reset cuts here and stops, an edit cuts here and
     * sends again.
     *
     * Refuses mid-turn. Truncating under a running stream would leave the
     * reply being written with no message to attach to.
     */
    async rewindTo(messageId: string) {
      const threadId = this.activeThread?.id
      if (!threadId || this.sending) return
      const res = await apiFetch<TruncateAssistantThreadResponse>(
        `/v1/assistant/threads/${threadId}/messages/${messageId}`,
        { method: 'DELETE' },
      )
      this.messages = res.messages
      this.live = null
      this.syncSummary(res.thread)
    },

    /**
     * Reset — rewind to just before a message.
     *
     * On your own message that is literal: it goes, and its text comes back
     * for the composer. On a reply it means asking again, which cuts from the
     * *question* above it rather than from the reply — re-sending appends a
     * fresh user turn, so leaving the old one would show the question twice.
     *
     * The re-sent turn carries the chat's current mode and no attachments: a
     * stored message records neither, so neither can be replayed.
     */
    async resetFrom(
      message: AssistantMessageInfo,
      opts: { documentId?: string; mode?: AssistantChatMode } = {},
    ): Promise<{ restored: string | null }> {
      if (this.sending) return { restored: null }
      if (message.role === 'user') {
        await this.rewindTo(message.id)
        return { restored: message.content }
      }
      const at = this.messages.findIndex((m) => m.id === message.id)
      const question = this.messages.slice(0, at).reverse().find((m) => m.role === 'user')
      if (!question) {
        // A reply with nothing above it to re-ask: drop it and stop there.
        await this.rewindTo(message.id)
        return { restored: null }
      }
      await this.rewindTo(question.id)
      await this.sendMessage(question.content, opts.documentId, { mode: opts.mode })
      return { restored: null }
    },

    /** Edit — rewind past a message and send it again, changed. */
    async editMessage(
      messageId: string,
      content: string,
      opts: { documentId?: string; mode?: AssistantChatMode } = {},
    ) {
      if (this.sending || !content.trim()) return
      await this.rewindTo(messageId)
      await this.sendMessage(content, opts.documentId, { mode: opts.mode })
    },

    /** Keeps the roster row in step with a thread the server just returned. */
    syncSummary(thread: AssistantThreadSummary) {
      const index = this.threads.findIndex((t) => t.id === thread.id)
      if (index >= 0) this.threads.splice(index, 1, { ...this.threads[index], ...thread })
      else this.threads.unshift(thread)
    },

    // ---- Turns ------------------------------------------------------------

    /**
     * Sends one turn and streams the reply. The optimistic user bubble is
     * replaced by the server's copy as soon as the first frame lands, so an
     * id-carrying message never sits next to a placeholder of itself.
     */
    async sendMessage(
      content: string,
      documentId?: string,
      opts: {
        mode?: AssistantChatMode
        attachments?: AssistantChatAttachment[]
        documentRefs?: string[]
        skillIds?: string[]
        agentKey?: string
      } = {},
    ) {
      if (!this.activeThread) await this.newThread(documentId)
      const thread = this.activeThread!
      this.sending = true
      this.error = null
      this.live = emptyTurn()
      const placeholder: AssistantMessageInfo = {
        id: `pending-${Date.now()}`,
        threadId: thread.id,
        role: 'user',
        content,
        toolCalls: [],
        sources: [],
        uiBlocks: [],
        prompt: null,
        createdAt: new Date().toISOString(),
      }
      this.messages.push(placeholder)

      const body = {
        content,
        ...(documentId ? { documentId } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
        ...(opts.documentRefs?.length ? { documentRefs: opts.documentRefs } : {}),
        ...(opts.skillIds?.length ? { skillIds: opts.skillIds } : {}),
        // '' means "follow the mode" — the server's own default, so it is
        // simply not sent rather than encoded as an empty string.
        ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      }

      const abort = markRaw(new AbortController())
      this.abort = abort
      let settled = false
      try {
        await streamAssistantTurn({
          threadId: thread.id,
          body,
          signal: abort.signal,
          onFrame: (frame) => {
            const live = this.live
            switch (frame.type) {
              case 'user-message': {
                const i = this.messages.findIndex((m) => m.id === placeholder.id)
                if (i >= 0) this.messages.splice(i, 1, frame.message)
                break
              }
              case 'status':
                if (live) live.phase = frame.phase
                break
              case 'delta':
                if (live) {
                  live.text += frame.text
                  live.phase = 'responding'
                }
                break
              case 'tool-call':
                if (!live) break
                if (frame.phase === 'started') {
                  // A tool call closes the current leg: whatever the model
                  // said up to here was thinking out loud, not the answer.
                  if (live.text.trim() || live.finished.length > 0) {
                    live.steps.push({ text: live.text.trim(), toolCalls: live.finished })
                    live.text = ''
                    live.finished = []
                  }
                  live.running.push(frame.tool)
                  live.phase = 'thinking'
                } else {
                  const at = live.running.indexOf(frame.tool)
                  if (at >= 0) live.running.splice(at, 1)
                  live.finished.push({ tool: frame.tool, arguments: '', ok: frame.ok })
                }
                break
              case 'ui-block':
                live?.uiBlocks.push(frame.block)
                break
              case 'prompt':
                if (live) live.prompt = frame.prompt
                break
              case 'sources':
                if (live) live.sources = frame.sources
                break
              case 'done':
                settled = true
                this.messages.push(frame.message)
                this.live = null
                this.touchThread(thread.id, frame.message.createdAt)
                break
              case 'error':
                settled = true
                this.error = frame.error.message
                this.live = null
                this.messages = this.messages.filter((m) => m.id !== placeholder.id)
                break
            }
          },
        })
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.abort = null
        this.sending = false
        if (!settled) {
          if (abort.signal.aborted) {
            // Stopped on purpose. The partial reply the server keeps is the
            // one that survives a reload, so hold the text on screen — frozen
            // — until `assistant.turn.finished` arrives and swaps it for the
            // saved copy. Blanking it here would flash the answer away and
            // back for no reason.
            if (this.live) this.live.stopped = true
            this.settleTimer = window.setTimeout(() => void this.reloadActive(), STOP_SETTLE_FALLBACK_MS)
          } else {
            // The connection died mid-turn. The turn kept running server-side,
            // so the thread on disk is the truth, not the fragment on screen.
            this.live = null
            await this.reloadActive()
          }
        }
      }
    },

    /**
     * Stops the turn — properly. Aborting the request closes the response,
     * which the API reads as cancellation and uses to stop the harness before
     * it reaches for another tool, so a stopped Agent turn cannot go on to
     * publish a page.
     */
    stopStreaming() {
      this.abort?.abort()
    },

    /** Re-reads the open thread from the server; the authority on what was saved. */
    async reloadActive() {
      if (this.settleTimer !== null) {
        clearTimeout(this.settleTimer)
        this.settleTimer = null
      }
      const id = this.activeThread?.id
      if (!id) return
      try {
        const res = await apiFetch<GetAssistantThreadResponse>(`/v1/assistant/threads/${id}`)
        this.messages = res.messages
        this.live = null
        this.syncSummary(res.thread)
      } catch {
        // Offline or deleted elsewhere — keep what is on screen rather than blanking it.
      }
    },

    /**
     * A turn finished somewhere else: another tab, or our own turn after we
     * stopped watching it. Ignored while this tab is mid-stream, where the
     * frames themselves are the better source.
     */
    onTurnFinished(threadId: string) {
      if (this.sending || this.activeThread?.id !== threadId) return
      void this.reloadActive()
    },

    touchThread(threadId: string, at: string) {
      const known = this.threads.find((t) => t.id === threadId)
      if (!known) return
      known.updatedAt = at
      // The server names an untitled thread after its first message; reflect
      // that here instead of leaving the row reading "New chat" until reload.
      if (!known.title) {
        const first = this.messages.find((m) => m.role === 'user')
        if (first) known.lastMessagePreview = first.content.slice(0, 140)
      }
    },
  },
})
