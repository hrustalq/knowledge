/**
 * A published site's search as a SearchSource (#205): the public search route
 * over one version's snapshot, mapped to the rows the app's SearchResults
 * draws. Only the facets a snapshot carries are sent — category and tag — so
 * nothing from the app's state (a project, a mode) can reach the route, which
 * would refuse it anyway.
 */
import {
  SITE_SEARCH_MIN_CHARS,
  publicSiteFacetsPath,
  publicSiteSearchPath,
  type PublicSiteFacetsResponse,
  type PublicSiteSearchResponse,
} from '@knowledge/contracts/publishing'
import { SearchNotice, type SearchSnapshot, type SearchSource } from '@/entities/search'
import { siteHomeId, siteHref, type PublicSiteChrome } from './reader-state'

export interface SiteSearchMessages {
  tooShort: string
  failed: string
  limited: string
}

/** The route's query for a state: the words, the version unless it is the default, each facet value once. */
export function siteSearchParams(site: Pick<PublicSiteChrome, 'version'>, state: SearchSnapshot): URLSearchParams {
  const params = new URLSearchParams({ q: state.query.trim() })
  if (!site.version.isDefault) params.set('version', site.version.slug)
  for (const c of state.categories) params.append('category', c)
  for (const tag of state.tags) params.append('tag', tag)
  return params
}

export function siteSearchSource(site: PublicSiteChrome, apiBase: string, messages: SiteSearchMessages): SearchSource {
  const homeId = siteHomeId(site.tree)
  return async (state) => {
    if (state.query.trim().length < SITE_SEARCH_MIN_CHARS) throw new SearchNotice(messages.tooShort)
    let res: Response
    try {
      res = await fetch(`${apiBase}${publicSiteSearchPath(site.id)}?${siteSearchParams(site, state)}`, {
        headers: { Accept: 'application/json' },
      })
    } catch {
      throw new SearchNotice(messages.failed)
    }
    if (res.status === 429) throw new SearchNotice(messages.limited)
    if (!res.ok) throw new SearchNotice(messages.failed)
    const body = (await res.json()) as PublicSiteSearchResponse
    return {
      results: body.results.map((r) => ({
        key: r.documentId,
        title: r.title,
        href: siteHref(site, site.version, r.slugPath, r.documentId === homeId),
        snippet: r.snippet,
        badges: r.tags.map((tag) => ({ key: tag.key, label: tag.name })),
      })),
      related: [],
    }
  }
}

/** The version's facets for the filter rail; none when they cannot be read, which leaves search working. */
export async function loadSiteFacets(site: Pick<PublicSiteChrome, 'id' | 'version'>, apiBase: string): Promise<PublicSiteFacetsResponse> {
  const params = new URLSearchParams()
  if (!site.version.isDefault) params.set('version', site.version.slug)
  try {
    const res = await fetch(`${apiBase}${publicSiteFacetsPath(site.id)}?${params}`, { headers: { Accept: 'application/json' } })
    if (res.ok) return (await res.json()) as PublicSiteFacetsResponse
  } catch {
    // fall through
  }
  return { categories: [], tags: [] }
}
