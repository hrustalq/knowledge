// The app's search source (docs/features/02): POST /v1/search in the active
// workspace. Kept out of use-search.ts so the public reader, which searches a
// site's snapshot instead, never bundles the app's API client.
import type { SearchRequest, SearchResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import type { SearchSnapshot, SearchSource, SearchView } from './use-search'

/** The one SearchRequest every app surface sends for a given state. */
export function searchRequestOf(state: SearchSnapshot): SearchRequest {
  const hasFilters = state.categories.length > 0 || state.projectIds.length > 0 || state.tags.length > 0
  return {
    workspaceId: getWorkspaceId(),
    query: state.query,
    mode: state.mode,
    limit: state.limit,
    ...(state.asOf ? { asOf: state.asOf } : {}),
    ...(state.expand && state.mode === 'hybrid' ? { expandGraph: { depth: state.depth } } : {}),
    ...(hasFilters
      ? {
          filters: {
            ...(state.categories.length > 0 ? { categories: state.categories } : {}),
            ...(state.projectIds.length > 0 ? { projectIds: state.projectIds } : {}),
            ...(state.tags.length > 0 ? { tags: state.tags } : {}),
          },
        }
      : {}),
  }
}

export function searchViewOf(res: SearchResponse): SearchView {
  // An `asOf` hit opens the page as it read then (#81), not as it reads now.
  const at = res.resolvedAsOf ? `?asOf=${encodeURIComponent(res.resolvedAsOf.ref === 'now' ? res.resolvedAsOf.at : res.resolvedAsOf.ref)}` : ''
  return {
    results: res.results.map((r) => ({
      key: r.chunkId,
      title: r.title,
      to: `/documents/${r.documentId}${at}`,
      // Chunk snippets are cut mid-sentence.
      snippet: [{ text: `${r.snippet}…`, hit: false }],
      score: r.score,
      trust: r.trust?.status,
      badges: (r.entities ?? []).map((e) => ({ key: e.key, label: e.name })),
      ...(r.validTo ? { supersededAt: r.validTo } : {}),
    })),
    related: (res.related ?? []).map((r) => ({
      key: r.documentId,
      title: r.title,
      to: `/documents/${r.documentId}`,
      distance: r.distance,
      via: r.via.map((v) => `${v.relationType} ${v.entityKey}`).join(', '),
    })),
  }
}

export const appSearchSource: SearchSource = async (state) =>
  searchViewOf(
    await apiFetch<SearchResponse>('/v1/search', {
      method: 'POST',
      body: JSON.stringify(searchRequestOf(state)),
    }),
  )
