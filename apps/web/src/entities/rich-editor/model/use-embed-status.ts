import { computed, inject, ref, type InjectionKey, type Ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { embedStatusKey, type EmbedItemStatus } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'

/**
 * The page an editor shows, for the embed node views inside it (#470). Given
 * by the page reader and the page editor; anywhere else (a comment, a
 * template, an import) no page is known and a group stays captions and links.
 */
export const EMBED_DOCUMENT: InjectionKey<Ref<string | null>> = Symbol('embed-document')

/** Polls while an item renders, and gives up after this many reads (a stopped worker must not poll forever). */
const POLL_MS = 4000
const MAX_POLLS = 30

/**
 * What the reader may show of each pinned item on the page, keyed by
 * `embedStatusKey`. One query per page, shared by every group on it.
 */
export function useEmbedStatus() {
  const documentId = inject(EMBED_DOCUMENT, ref(null))
  const query = useQuery(
    computed(() => ({
      ...apiQueryOptions('/v1/documents/{id}/embeds', { path: { id: documentId.value ?? '' } }),
      enabled: !!documentId.value,
      refetchInterval: (q: { state: { data?: { items: EmbedItemStatus[] }; dataUpdateCount: number } }) =>
        q.state.dataUpdateCount < MAX_POLLS && q.state.data?.items.some((i) => i.state === 'rendering') ? POLL_MS : false,
    })),
  )
  const byKey = computed(
    () => new Map((query.data.value?.items ?? []).map((i) => [embedStatusKey(i.fileKey, i.nodeId, i.version), i])),
  )
  return { documentId, byKey }
}
