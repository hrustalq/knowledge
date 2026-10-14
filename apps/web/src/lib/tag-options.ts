import type { ListEntitiesResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'

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
export async function loadTagOptions(query: string): Promise<TagOption[]> {
  const params = new URLSearchParams({ workspaceId: getWorkspaceId(), type: 'tag', limit: '200' })
  if (query.trim()) params.set('q', query.trim())
  const res = await apiFetch<ListEntitiesResponse>(`/v1/entities?${params}`)
  return res.entities.map((e) => ({ value: e.key, label: e.name, meta: e.degree }))
}

/** What a selected tag reads as before its option is loaded. */
export const tagLabel = (value: string): string => value.replace(/^tag:/, '')
