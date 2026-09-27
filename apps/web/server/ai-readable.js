// AI-readable output on the web origin (issue #68, phase 3).
//
// The API already renders a page as markdown (`GET /v1/documents/:id/markdown`)
// and a scope as llms.txt (`/v1/…/llms(-full).txt`). This middleware makes the
// URLs people actually paste work too:
//
//   /documents/:id.md                          → /v1/documents/:id/markdown
//   /documents/:id   + Accept: text/markdown   → /v1/documents/:id/markdown
//   /llms.txt                                  → /v1/llms.txt
//   /workspaces/:id/llms(-full).txt            → /v1/workspaces/:id/llms(-full).txt
//   /projects/:id/llms(-full).txt              → /v1/projects/:id/llms(-full).txt
//
// It is a pass-through, never a renderer: the bytes, status, ETag and cache
// headers are the API's, so the web copy cannot drift from the API copy. The
// body is streamed, because llms-full.txt can be large.
//
// Plain JS on purpose: server.js is unbundled Node, and Dockerfile.web copies
// this directory next to it.

import { Readable } from 'node:stream'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const DOC_MD = new RegExp(`^/documents/(${UUID})\\.md$`)
const DOC_PAGE = new RegExp(`^/documents/(${UUID})/?$`)
const SCOPED_LLMS = new RegExp(`^/(workspaces|projects)/(${UUID})/(llms|llms-full)\\.txt$`)

/**
 * Parse an Accept header into `{ type, q }` entries. Parameters other than `q`
 * are ignored; a malformed q counts as 0, which is what RFC 9110 asks a server
 * to do with an entry it cannot read.
 * @param {string | undefined} header
 * @returns {{ type: string, q: number }[]}
 */
export function parseAccept(header) {
  if (!header) return []
  const out = []
  for (const part of header.split(',')) {
    const [rawType, ...params] = part.split(';')
    const type = rawType.trim().toLowerCase()
    if (!type) continue
    let q = 1
    for (const p of params) {
      const [k, v] = p.split('=').map((s) => s.trim())
      if (k?.toLowerCase() === 'q') {
        const n = Number(v)
        q = Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0
      }
    }
    out.push({ type, q })
  }
  return out
}

/** Quality the header gives one concrete type — the most specific match wins. */
function qualityOf(entries, type) {
  const [major] = type.split('/')
  let best = null
  let specificity = -1
  for (const e of entries) {
    const s = e.type === type ? 2 : e.type === `${major}/*` ? 1 : e.type === '*/*' ? 0 : -1
    if (s > specificity) {
      specificity = s
      best = e.q
    }
  }
  return best ?? 0
}

/**
 * Does this request ask for the markdown representation of a page rather than
 * the HTML app? Only when `text/markdown` is named explicitly and ranked
 * strictly above `text/html`. A browser's `text/html,…,*∕*;q=0.8` must keep
 * getting the SSR page, and so must a bare `*∕*` (curl's default) — a
 * wildcard never selects markdown on its own.
 * @param {string | undefined} header
 */
export function prefersMarkdown(header) {
  const entries = parseAccept(header)
  if (!entries.some((e) => e.type === 'text/markdown' && e.q > 0)) return false
  return qualityOf(entries, 'text/markdown') > qualityOf(entries, 'text/html')
}

/**
 * Map a web path (no query string) to the API path it mirrors, or null when the
 * middleware should let the request through to the SSR app.
 * @param {string} path
 * @param {string | undefined} accept
 * @returns {string | null}
 */
export function apiPathFor(path, accept) {
  let m = DOC_MD.exec(path)
  if (m) return `/v1/documents/${m[1].toLowerCase()}/markdown`
  m = DOC_PAGE.exec(path)
  if (m && prefersMarkdown(accept)) return `/v1/documents/${m[1].toLowerCase()}/markdown`
  if (path === '/llms.txt') return '/v1/llms.txt'
  m = SCOPED_LLMS.exec(path)
  if (m) return `/v1/${m[1]}/${m[2].toLowerCase()}/${m[3]}.txt`
  return null
}

/** True for `/documents/:id` — the SSR response there varies on Accept. */
export function isNegotiablePage(path) {
  return DOC_PAGE.test(path)
}

/**
 * The credential to forward. An explicit Authorization header wins (an agent
 * with an API key); otherwise the browser's `kn_token` session cookie, which is
 * what makes opening `/documents/:id.md` in a logged-in tab work. Never a
 * `?token=` query — a credential in a URL leaks into logs and history.
 * @param {string | undefined} authorization
 * @param {string | null} cookieToken
 * @returns {string | null}
 */
export function forwardedAuthorization(authorization, cookieToken) {
  if (authorization && authorization.trim()) return authorization
  if (cookieToken) return `Bearer ${cookieToken}`
  return null
}

const UNAUTHORIZED_HINT =
  'Unauthorized: this is a private knowledge base.\n' +
  'Create an API key at /settings/connect and send it as a bearer token:\n\n' +
  '  curl -H "Authorization: Bearer $KNOWLEDGE_API_KEY" <this URL>\n'

// Response headers copied from the API. Everything else (Nest's own, hop-by-hop,
// content-length of a body we may re-encode) stays behind.
const PASS_HEADERS = [
  'content-type',
  'etag',
  'cache-control',
  'vary',
  'x-robots-tag',
  'x-content-type-options',
  'last-modified',
  'content-disposition',
]

/** One short text line from an API error body ({ message } per ApiErrorPayload). */
async function errorText(upstream) {
  const raw = await upstream.text().catch(() => '')
  try {
    const body = JSON.parse(raw)
    const msg = Array.isArray(body?.message) ? body.message.join('; ') : body?.message
    if (typeof msg === 'string' && msg) return msg
  } catch {
    /* not JSON: fall through */
  }
  return raw.trim() || upstream.statusText || 'Error'
}

function appendVary(res, value) {
  const current = String(res.getHeader('Vary') ?? '')
  const parts = current.split(',').map((s) => s.trim()).filter(Boolean)
  for (const v of value.split(',').map((s) => s.trim())) {
    if (!parts.some((p) => p.toLowerCase() === v.toLowerCase())) parts.push(v)
  }
  res.setHeader('Vary', parts.join(', '))
}

/**
 * @param {{
 *   apiBase: string,
 *   readCookie: (header: string | undefined, name: string) => string | null,
 *   fetch?: typeof globalThis.fetch,
 *   logger?: { warn: (o: object) => void },
 * }} opts
 * @returns {import('express').RequestHandler}
 */
export function aiReadableMiddleware({ apiBase, readCookie, fetch = globalThis.fetch, logger }) {
  const base = apiBase.replace(/\/+$/, '')
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const path = req.path
    const apiPath = apiPathFor(path, req.headers.accept)
    if (!apiPath) {
      // The SSR HTML for a page is one of two representations: caches must key on Accept.
      if (isNegotiablePage(path)) appendVary(res, 'Accept')
      return next()
    }

    res.setHeader('X-Content-Type-Options', 'nosniff')
    appendVary(res, 'Accept, Authorization, Cookie')

    // No credential is not a 401 here: whether one is needed is the API's call
    // (AUTH_MODE=none accepts anonymous requests). An upstream 401 becomes the
    // same plain-text hint below.
    const auth = forwardedAuthorization(req.headers.authorization, readCookie(req.headers.cookie, 'kn_token'))

    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
    /** @type {Record<string, string>} */
    const headers = { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' }
    if (auth) headers.authorization = auth
    for (const h of ['if-none-match', 'accept-language', 'x-request-id']) {
      const v = req.headers[h]
      if (typeof v === 'string' && v) headers[h] = v
    }
    const traceId = res.getHeader('x-request-id')
    if (typeof traceId === 'string' && !headers['x-request-id']) headers['x-request-id'] = traceId

    let upstream
    try {
      upstream = await fetch(`${base}${apiPath}${qs}`, { method: req.method, headers, redirect: 'manual' })
    } catch (err) {
      logger?.warn({ msg: 'ai-readable upstream failed', route: req.originalUrl, err })
      res.status(502).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end('Bad Gateway: the knowledge API is unreachable.\n')
    }

    if (upstream.status === 401) {
      res.status(401).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(UNAUTHORIZED_HINT)
    }
    if (upstream.status >= 400) {
      // Agents read this: plain text, not the API's JSON envelope.
      const msg = await errorText(upstream)
      res.status(upstream.status).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(`${upstream.status} ${msg}\n`)
    }

    res.status(upstream.status)
    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h)
      if (v == null) continue
      if (h === 'vary') appendVary(res, v)
      else res.setHeader(h, v)
    }
    if (!upstream.body || upstream.status === 304 || req.method === 'HEAD') return res.end()

    const body = Readable.fromWeb(upstream.body)
    body.on('error', (err) => {
      logger?.warn({ msg: 'ai-readable stream aborted', route: req.originalUrl, err })
      res.destroy(err)
    })
    res.on('close', () => body.destroy())
    body.pipe(res)
  }
}
