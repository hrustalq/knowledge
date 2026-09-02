// Chat pane (docs/features/09 follow-up): a persisted multi-turn thread per
// workspace/document, mirroring stores/documents.ts and stores/events.ts in
// shape. The sidebar derives "documents touched" from message.sources rather
// than parsing chat text — see assistant-threads.service.ts on the API side.
import { defineStore } from 'pinia'
import type {
  AssistantAskSource,
  AssistantChatAttachment,
  AssistantChatMode,
  AssistantMessageInfo,
  AssistantThreadSummary,
  CreateAssistantThreadResponse,
  GetAssistantThreadResponse,
  ListAssistantThreadsResponse,
  PostAssistantMessageResponse,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'

export const useAssistantStore = defineStore('assistant', {
  state: () => ({
    threads: [] as AssistantThreadSummary[],
    threadsLoaded: false,
    activeThread: null as AssistantThreadSummary | null,
    messages: [] as AssistantMessageInfo[],
    sending: false,
    error: null as string | null,
  }),
  getters: {
    /** Documents referenced or written to in this thread, most recent first, deduped. */
    documentsTouched(state): AssistantAskSource[] {
      const byId = new Map<string, AssistantAskSource>()
      for (const m of state.messages) {
        for (const s of m.sources) byId.set(s.documentId, s)
      }
      return [...byId.values()].reverse()
    },
    /** This thread's own sent messages, oldest first — the composer walks this backwards on ArrowUp
     * (shell-style recall), so a stale placeholder from a failed send never shows up in the list. */
    sentHistory(state): string[] {
      return state.messages.filter((m) => m.role === 'user' && !m.id.startsWith('pending-')).map((m) => m.content)
    },
  },
  actions: {
    async fetchThreads() {
      const res = await apiFetch<ListAssistantThreadsResponse>(
        `/v1/assistant/threads?workspaceId=${getWorkspaceId()}`,
      )
      this.threads = res.threads
      this.threadsLoaded = true
    },

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
      this.error = null
    },

    async openThread(threadId: string) {
      const res = await apiFetch<GetAssistantThreadResponse>(
        `/v1/assistant/threads/${threadId}?workspaceId=${getWorkspaceId()}`,
      )
      this.activeThread = res.thread
      this.messages = res.messages
      this.error = null
    },

    async sendMessage(
      content: string,
      documentId?: string,
      opts: { mode?: AssistantChatMode; attachments?: AssistantChatAttachment[]; documentRefs?: string[] } = {},
    ) {
      if (!this.activeThread) await this.newThread(documentId)
      const thread = this.activeThread!
      this.sending = true
      this.error = null
      // Optimistic placeholder so the user sees their message immediately;
      // replaced by the server copy (with a real id) once the request lands.
      const placeholder: AssistantMessageInfo = {
        id: `pending-${Date.now()}`,
        threadId: thread.id,
        role: 'user',
        content,
        toolCalls: [],
        sources: [],
        uiBlocks: [],
        createdAt: new Date().toISOString(),
      }
      this.messages.push(placeholder)
      try {
        const res = await apiFetch<PostAssistantMessageResponse>(
          `/v1/assistant/threads/${thread.id}/messages?workspaceId=${getWorkspaceId()}`,
          {
            method: 'POST',
            body: JSON.stringify({
              content,
              ...(documentId ? { documentId } : {}),
              ...(opts.mode ? { mode: opts.mode } : {}),
              ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
              ...(opts.documentRefs?.length ? { documentRefs: opts.documentRefs } : {}),
            }),
          },
        )
        const idx = this.messages.findIndex((m) => m.id === placeholder.id)
        if (idx >= 0) this.messages.splice(idx, 1, res.userMessage)
        this.messages.push(res.assistantMessage)
        const known = this.threads.find((t) => t.id === thread.id)
        if (known) known.updatedAt = res.assistantMessage.createdAt
      } catch (e) {
        this.error = (e as Error).message
        this.messages = this.messages.filter((m) => m.id !== placeholder.id)
      } finally {
        this.sending = false
      }
    },
  },
})
