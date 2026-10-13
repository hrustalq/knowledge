import { describe, expect, it } from 'vitest'
import { createRenderCache, renderCacheKey } from './render-cache.js'

/**
 * The site render cache (issue #77 phase 2b-2). What is pinned: entries are
 * least-recently-used first out and bounded by bytes, an entry larger than
 * the whole budget is not kept, 0 turns the cache off, and the key keeps
 * hosts, languages and URLs apart.
 */

const render = (chars) => ({ html: 'x'.repeat(chars), head: '', status: 200, headers: {} })
// Two bytes a character plus the 512-byte allowance, as render-cache.js charges.
const cost = (chars) => 2 * chars + 512

describe('createRenderCache', () => {
  it('keeps renders with their tag and evicts the least recently used past the budget', () => {
    const cache = createRenderCache({ maxBytes: cost(1000) * 2 })
    cache.set('a', '"1"', render(1000))
    cache.set('b', '"2"', render(1000))
    expect(cache.get('a').etag).toBe('"1"') // `a` is now the most recent
    cache.set('c', '"3"', render(1000))
    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).not.toBeNull()
    expect(cache.get('c')).not.toBeNull()
    expect(cache.bytes).toBe(cost(1000) * 2)
  })

  it('replaces an entry in place, and forgets one on delete', () => {
    const cache = createRenderCache({ maxBytes: 1_000_000 })
    cache.set('a', '"1"', render(10))
    cache.set('a', '"2"', render(20))
    expect(cache.size).toBe(1)
    expect(cache.get('a').etag).toBe('"2"')
    expect(cache.bytes).toBe(cost(20))
    cache.delete('a')
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('does not keep a render larger than the whole budget, nor empty itself trying', () => {
    const cache = createRenderCache({ maxBytes: cost(100) })
    cache.set('small', '"1"', render(100))
    cache.set('huge', '"2"', render(10_000))
    expect(cache.get('huge')).toBeNull()
    expect(cache.get('small')).not.toBeNull()
  })

  it('is off at 0', () => {
    const cache = createRenderCache({ maxBytes: 0 })
    expect(cache.enabled).toBe(false)
    cache.set('a', '"1"', render(1))
    expect(cache.get('a')).toBeNull()
  })
})

describe('renderCacheKey', () => {
  it('differs by host, language and URL — what decides a site render’s bytes', () => {
    const base = { siteHost: 'docs.acme.com', url: '/guide', locale: 'en' }
    const keys = new Set([
      renderCacheKey(base),
      renderCacheKey({ ...base, siteHost: 'docs.other.com' }),
      renderCacheKey({ ...base, siteHost: null, url: '/pub/acme/guide' }),
      renderCacheKey({ ...base, locale: 'ru' }),
      renderCacheKey({ ...base, url: '/guide?x=1' }),
    ])
    expect(keys.size).toBe(5)
  })
})
