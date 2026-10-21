// Chat search (#339): POST /v1/chat/search, drawn by the same SearchPanel as
// page search so the two tabs share their states. A window is never a page:
// it links out to the platform where there is a link, and is plain text where
// there is none.
import type { ChatSearchResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { formatDateTimeRange } from '@/lib/format'
import type { SearchSource } from './use-search'

type Translate = (key: string, params?: Record<string, unknown>, plural?: number) => string

export function chatSearchSource(t: Translate): SearchSource {
  return async (state) => {
    const res = await apiFetch<ChatSearchResponse>('/v1/chat/search', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        query: state.query,
        limit: state.limit,
      }),
    })
    return {
      results: res.hits.map((h) => ({
        key: h.chunkId,
        title: h.chatTitle || t('chatBots.bindings.untitled'),
        ...(h.url ? { href: h.url, external: true } : {}),
        // Masked on write, `author-n` labels only: safe to show as it is.
        snippet: [{ text: h.snippet, hit: false }],
        badges: [
          { key: 'platform', label: t(`chatBots.kind.${h.platform}`) },
          { key: 'span', label: formatDateTimeRange(h.firstAt, h.lastAt) },
          { key: 'count', label: t('search.chat.messages', { n: h.messageCount }, h.messageCount) },
        ],
      })),
      related: [],
    }
  }
}
