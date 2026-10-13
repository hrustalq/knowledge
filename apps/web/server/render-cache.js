/**
 * The render cache of published site pages (docs/features/44, issue #77
 * phase 2b-2).
 *
 * An entry is one finished render — host, URL and language decide the bytes,
 * since the site reader reads no cookie — kept with the ETag the API's
 * `resolve` gave for what it was made from. Every request still asks the API,
 * with that tag: the site, its status and the workspace switch are looked up
 * afresh each time, so an unpublish ends a site on the next request exactly
 * as before. What a 304 saves is everything after that check — the page body
 * from object storage, the markdown render, the sanitiser and the Vue SSR
 * pass.
 *
 * A plain least-recently-used map bounded by bytes, in this process only: a
 * restart (which is also how a new web build arrives) starts it empty.
 */

/** Bytes an entry is charged: what it holds is strings, two bytes a code unit at worst. */
function sizeOf(rendered) {
  return 2 * ((rendered.html?.length ?? 0) + (rendered.head ?? '').length) + 512
}

/**
 * @param {{ maxBytes: number }} options `maxBytes <= 0` disables the cache.
 */
export function createRenderCache({ maxBytes }) {
  /** @type {Map<string, { etag: string, rendered: object, bytes: number }>} */
  const entries = new Map()
  let bytes = 0

  function drop(key) {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    bytes -= entry.bytes
  }

  return {
    get enabled() {
      return maxBytes > 0
    },
    get size() {
      return entries.size
    },
    get bytes() {
      return bytes
    },

    /** The entry for `key`, now the most recently used; null when there is none. */
    get(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      entries.set(key, entry)
      return entry
    },

    /** Keep a render. One larger than the whole budget is not kept, and does not empty the cache trying. */
    set(key, etag, rendered) {
      drop(key)
      const size = sizeOf(rendered)
      if (maxBytes <= 0 || size > maxBytes) return
      entries.set(key, { etag, rendered, bytes: size })
      bytes += size
      // A Map iterates in insertion order, and `get` re-inserts: the first key is the least recently used.
      for (const oldest of entries.keys()) {
        if (bytes <= maxBytes) break
        drop(oldest)
      }
    },

    delete: drop,
  }
}

/** What decides a site render's bytes. A share never reaches the cache: its render carries no ETag. */
export function renderCacheKey({ siteHost, url, locale }) {
  return `${siteHost ?? ''}\n${locale}\n${url}`
}
