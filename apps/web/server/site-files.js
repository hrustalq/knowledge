// Published sites on the web origin (docs/features/44, issue #77 phase 2b):
// which host is a site's, and the site's machine-readable files.
//
// A request is a site's when its host is `<slug>.<PUBLISH_BASE_DOMAIN>` (by
// shape) or a custom domain the API says belongs to a site (looked up and
// cached). The host is the `Host` header, or `X-Forwarded-Host` when the peer
// is internal — the front proxy's, which is how a site host reaches this
// process through an edge that rewrites `Host` (production's Worker -> Funnel).
//
// On a site, these paths go to the API instead of the SSR reader, as a
// pass-through (the bytes, status and ETag are the API's):
//
//   /sitemap.xml                       -> /v1/public/sites/sitemap.xml
//   /robots.txt                        -> /v1/public/sites/robots.txt
//   [/<version>]/llms.txt              -> /v1/public/sites/llms.txt
//   [/<version>]/llms-full.txt         -> /v1/public/sites/llms-full.txt
//   /<page path>.md                    -> /v1/public/sites/markdown
//
// In path mode the same paths sit under `/pub/<slug>`. Nothing from the
// visitor's cookies or Authorization reaches the API: a site is public.
//
// Plain JS on purpose: server.js is unbundled Node, and Dockerfile.web copies
// this directory next to it.

import { isIP } from 'node:net'
import { relay } from './ai-readable.js'

const SITE_PREFIX = /^\/pub\/([a-z0-9-]+)(\/.*)?$/

/**
 * IPv4 private, loopback, link-local and CGNAT ranges, and their IPv6
 * equivalents: the same predicate as the API's `clientIp` (public-rate-limit.ts).
 * @param {string | undefined} address
 */
export function isInternalAddress(address) {
  if (!address) return false
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  const lower = ip.toLowerCase()
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
}

/** `Host:port.` → `host`, lower-cased; '' for nothing usable. */
function bareHost(value) {
  return String(value ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
}

/**
 * The host the visitor asked for. `X-Forwarded-Host` is believed only from an
 * internal peer, as the API believes `X-Forwarded-For`: a visitor reaching
 * this process directly cannot name a host it did not connect to.
 * @param {{ headers: Record<string, unknown>, socket: { remoteAddress?: string } }} req
 */
export function requestHost(req) {
  const forwarded = req.headers['x-forwarded-host']
  if (typeof forwarded === 'string' && forwarded.trim() && isInternalAddress(req.socket.remoteAddress)) {
    return bareHost(forwarded)
  }
  return bareHost(req.headers.host)
}

/** A name worth asking the API about: dotted, not an IP, not `localhost`. */
function lookupWorthy(host) {
  return host.includes('.') && !isIP(host) && !host.endsWith('.localhost') && /^[a-z0-9.-]+$/.test(host)
}

/**
 * Decides, per request, whether the host is a site's.
 *
 * Custom domains are asked of the API (`/v1/public/domains/allow`, the same
 * check Caddy's on-demand TLS makes) and remembered for `ttlMs` either way, so
 * a host costs at most one lookup per minute. A lookup that fails (API down,
 * rate-limited) is not remembered and counts as "not a site" for that request.
 * The visitor's address goes along, so the API's per-address limit counts the
 * visitor rather than this process.
 *
 * @param {{
 *   apiBase: string,
 *   baseDomain: string,
 *   appHost: string | null,
 *   fetch?: typeof globalThis.fetch,
 *   ttlMs?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 * }} opts
 */
export function createSiteHostResolver({
  apiBase,
  baseDomain,
  appHost,
  fetch = globalThis.fetch,
  ttlMs = 60_000,
  maxEntries = 1000,
  now = Date.now,
}) {
  const base = apiBase.replace(/\/+$/, '')
  /** @type {Map<string, { site: boolean, until: number }>} */
  const cache = new Map()

  /**
   * @param {import('express').Request} req
   * @param {string | null} forwardedFor
   * @returns {Promise<string | null>} the site host, or null for the app's own
   */
  return async function siteHostOf(req, forwardedFor) {
    const host = requestHost(req)
    if (!host) return null
    if (baseDomain && host.endsWith(`.${baseDomain}`)) {
      const label = host.slice(0, -(baseDomain.length + 1))
      return label && !label.includes('.') ? host : null
    }
    if (host === appHost || !lookupWorthy(host)) return null

    const hit = cache.get(host)
    if (hit && hit.until > now()) return hit.site ? host : null

    let site
    try {
      /** @type {Record<string, string>} */
      const headers = { accept: 'application/json' }
      if (forwardedFor) headers['x-forwarded-for'] = forwardedFor
      const res = await fetch(`${base}/v1/public/domains/allow?domain=${encodeURIComponent(host)}`, { headers })
      if (res.status !== 200 && res.status !== 404) return null
      site = res.status === 200
    } catch {
      return null
    }
    cache.delete(host)
    cache.set(host, { site, until: now() + ttlMs })
    // A Map iterates in insertion order: the first key is the oldest entry.
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value)
    return site ? host : null
  }
}

/**
 * The API route and query for a site file, or null when the path is a page
 * for the SSR reader. `rest` is the path below the site root.
 * @param {string} rest
 * @returns {{ route: string, params: Record<string, string> } | null}
 */
export function siteFileFor(rest) {
  const path = rest || '/'
  if (path === '/sitemap.xml') return { route: 'sitemap.xml', params: {} }
  if (path === '/robots.txt') return { route: 'robots.txt', params: {} }
  const llms = /^(?:\/([^/]+))?\/(llms|llms-full)\.txt$/.exec(path)
  if (llms) return { route: `${llms[2]}.txt`, params: llms[1] ? { version: decodeSegment(llms[1]) } : {} }
  const md = /^\/(.+)\.md$/.exec(path)
  if (md) return { route: 'markdown', params: { path: md[1] } }
  return null
}

function decodeSegment(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Serves a site's files from the API, on a site host or under `/pub/<slug>`.
 * Expects `res.locals.siteHost` (set by server.js before this runs).
 * @param {{
 *   apiBase: string,
 *   forwardedFor: (req: import('express').Request) => string | null,
 *   fetch?: typeof globalThis.fetch,
 *   logger?: { warn: (o: object) => void },
 * }} opts
 * @returns {import('express').RequestHandler}
 */
export function siteFilesMiddleware({ apiBase, forwardedFor, fetch = globalThis.fetch, logger }) {
  const base = apiBase.replace(/\/+$/, '')
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const siteHost = res.locals.siteHost
    const prefixed = siteHost ? null : SITE_PREFIX.exec(req.path)
    if (!siteHost && !prefixed) return next()
    const file = siteFileFor(siteHost ? req.path : (prefixed[2] ?? '/'))
    if (!file) return next()

    const params = new URLSearchParams(file.params)
    if (siteHost) params.set('host', siteHost)
    else params.set('slug', prefixed[1])

    /** @type {Record<string, string>} */
    const headers = { accept: '*/*' }
    const ff = forwardedFor(req)
    if (ff) headers['x-forwarded-for'] = ff
    for (const h of ['if-none-match', 'accept-language']) {
      const v = req.headers[h]
      if (typeof v === 'string' && v) headers[h] = v
    }
    const traceId = res.getHeader('x-request-id')
    if (typeof traceId === 'string') headers['x-request-id'] = traceId

    let upstream
    try {
      upstream = await fetch(`${base}/v1/public/sites/${file.route}?${params}`, { method: req.method, headers, redirect: 'manual' })
    } catch (err) {
      logger?.warn({ msg: 'site file upstream failed', route: req.originalUrl, err })
      res.status(502).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end('Bad Gateway\n')
    }
    return relay(req, res, upstream, logger)
  }
}
