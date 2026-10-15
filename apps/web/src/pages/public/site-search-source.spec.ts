import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicSiteSearchResponse } from '@knowledge/contracts'
import { SearchNotice, type SearchSnapshot } from '@/components/knowledge/use-search'
import type { PublicSiteChrome } from './reader-state'
import { loadSiteFacets, siteSearchParams, siteSearchSource } from './site-search-source'

/**
 * The reader's search source (#205): what reaches the public route is the
 * words, the version and the snapshot's facets — never the app's project,
 * mode or graph state — and every failure is a sentence the reader reads.
 */

const latest = { slug: 'latest', name: 'Latest', isDefault: true }
const v1 = { slug: 'v1', name: 'v1', isDefault: false }

const site = (version = latest) =>
  ({
    id: 'site-1',
    prefix: '/pub/acme',
    version,
    tree: [{ documentId: 'home', parentId: null, title: 'Home', slugPath: 'welcome', position: 0, childCount: 0 }],
  }) as unknown as PublicSiteChrome

const state = (over: Partial<SearchSnapshot> = {}): SearchSnapshot => ({
  query: 'install',
  mode: 'hybrid',
  categories: [],
  projectIds: [],
  tags: [],
  expand: true,
  depth: 1,
  limit: 20,
  ...over,
})

const messages = { tooShort: 'short', failed: 'failed', limited: 'limited' }

function respond(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('siteSearchParams', () => {
  it('sends the facets a snapshot carries and nothing of the app’s state', () => {
    const params = siteSearchParams(
      site(v1),
      state({ query: ' sundew ', categories: ['guide', 'reference'], tags: ['tag:ops'], projectIds: ['p1'], mode: 'semantic' }),
    )
    expect([...params]).toEqual([
      ['q', 'sundew'],
      ['version', 'v1'],
      ['category', 'guide'],
      ['category', 'reference'],
      ['tag', 'tag:ops'],
    ])
  })

  it('leaves the default version implicit', () => {
    expect(siteSearchParams(site(), state()).has('version')).toBe(false)
  })
})

describe('siteSearchSource', () => {
  it('maps results to plain links, the home page at the version root, tags as badges', async () => {
    const body: PublicSiteSearchResponse = {
      results: [
        { documentId: 'home', title: 'Home', slugPath: 'welcome', snippet: [], category: 'other', tags: [] },
        {
          documentId: 'd1',
          title: 'Install',
          slugPath: 'guide/install',
          snippet: [{ text: 'make', hit: true }],
          category: 'guide',
          tags: [{ key: 'tag:ops', name: 'Ops' }],
        },
      ],
    }
    const fetchMock = respond(200, body)
    const view = await siteSearchSource(site(), 'https://api.test', messages)(state({ categories: ['guide'] }))
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.test/v1/public/sites/site-1/search?q=install&category=guide',
    )
    expect(view).toEqual({
      results: [
        { key: 'home', title: 'Home', href: '/pub/acme/', snippet: [], badges: [] },
        {
          key: 'd1',
          title: 'Install',
          href: '/pub/acme/guide/install',
          snippet: [{ text: 'make', hit: true }],
          badges: [{ key: 'tag:ops', label: 'Ops' }],
        },
      ],
      related: [],
    })
  })

  it('turns every failure into a notice: too short, rate-limited, refused or offline', async () => {
    const run = siteSearchSource(site(), '', messages)
    const fetchMock = respond(200, { results: [] })
    await expect(run(state({ query: 'a' }))).rejects.toEqual(new SearchNotice('short'))
    expect(fetchMock).not.toHaveBeenCalled()

    respond(429)
    await expect(run(state())).rejects.toEqual(new SearchNotice('limited'))
    respond(400)
    await expect(run(state())).rejects.toEqual(new SearchNotice('failed'))
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    await expect(run(state())).rejects.toBeInstanceOf(SearchNotice)
  })
})

describe('loadSiteFacets', () => {
  it('asks for the version’s facets, and offers none when they cannot be read', async () => {
    const fetchMock = respond(200, { categories: [{ value: 'guide', count: 2 }], tags: [] })
    expect(await loadSiteFacets(site(v1), '')).toEqual({ categories: [{ value: 'guide', count: 2 }], tags: [] })
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/v1/public/sites/site-1/facets?version=v1')
    respond(500)
    expect(await loadSiteFacets(site(), '')).toEqual({ categories: [], tags: [] })
  })
})
