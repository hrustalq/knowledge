// The app's search source (docs/features/02): POST /v1/search in the active
// workspace. Kept out of use-search.ts so the public reader, which searches a
// site's snapshot instead, never bundles the app's API client.
import type { SearchRequest, SearchResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import type { SearchSnapshot, SearchSource, SearchView } from './use-search'

/**
 * The one SearchRequest every app surface sends for a given state. Typed by
 * what it holds (`satisfies`), not widened to the contract: the generated
 * client requires the fields the DTO defaults, and this always sets them.
 */
export function searchRequestOf(state: SearchSnapshot) {
  const hasFilters = state.categories.length > 0 || state.projectIds.length > 0 || state.tags.length > 0
  return {
    workspaceId: getWorkspaceId(),
    query: state.query,
    mode: state.mode,
    limit: state.limit,
    // One row per page, the matched words marked (#443).
    groupBy: 'page',
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
  } satisfies SearchRequest
}

export function searchViewOf(res: SearchResponse): SearchView {
  // An `asOf` hit opens the page as it read then (#81), not as it reads now.
  const asOf = res.resolvedAsOf ? (res.resolvedAsOf.ref === 'now' ? res.resolvedAsOf.at : res.resolvedAsOf.ref) : null
  // The search and the row's rank ride along so the view counts as its click (#79).
  const linkOf = (documentId: string, rank: number) => {
    const q = new URLSearchParams({
      ...(asOf ? { asOf } : {}),
      ...(res.searchId ? { sid: res.searchId, rank: String(rank) } : {}),
    }).toString()
    return `/documents/${documentId}${q ? `?${q}` : ''}`
  }
  return {
    results: res.results.map((r, i) => ({
      key: r.documentId,
      title: r.title,
      to: linkOf(r.documentId, i + 1),
      // Chunk snippets are cut mid-sentence.
      snippet: r.snippetParts ?? [{ text: `${r.snippet}…`, hit: false }],
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
    await api.post('/v1/search', { body: searchRequestOf(state) }),
  )
