import { useQueryClient } from '@tanstack/vue-query'
import { fetchApi } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'

/** The `AutocompleteOption` shape, spelled out: lib/ may not import from components/. */
export interface TagOption {
  value: string
  label: string
  meta?: number
}

/**
 * The workspace's tags as autocomplete options, searched server-side against
 * GET /v1/entities?type=tag&q= — the roster is unbounded, so it is never held
 * locally. Values are entity keys (`tag:billing`); shared by every tag picker
 * so the search sheet and a chat subscription pick tags the same way.
 */
export function useTagOptions(): (query: string) => Promise<TagOption[]> {
  const queryClient = useQueryClient()
  return async (query) => {
    const q = query.trim()
    const res = await fetchApi(queryClient, '/v1/entities', {
      query: { workspaceId: getWorkspaceId(), type: 'tag', limit: '200', ...(q ? { q } : {}) },
    })
    return res.entities.map((e) => ({ value: e.key, label: e.name, meta: e.degree }))
  }
}

/** What a selected tag reads as before its option is loaded. */
export const tagLabel = (value: string): string => value.replace(/^tag:/, '')
