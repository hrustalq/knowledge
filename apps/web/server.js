import fs from 'node:fs/promises'
import express from 'express'
import { configureBacktest, createRootLogger, envLogLevel } from '@knowledge/observability'
import { traceMiddleware } from '@knowledge/observability/express'
import { aiReadableMiddleware } from './server/ai-readable.js'
import { createSiteHostResolver, siteFilesMiddleware } from './server/site-files.js'

// Constants
const isProduction = process.env.NODE_ENV === 'production'
const port = process.env.PORT || 5173
const base = process.env.BASE || '/'

// The same logger apps/api runs, so an SSR render and the API request it makes
// land in one stream under one trace id. This process previously wrote nothing
// but bare console.log, which made an SSR failure unattributable to the page
// that caused it.
const logger = createRootLogger({ service: 'web-ssr', level: envLogLevel() })
const OFF = new Set(['false', '0', 'no', 'off'])
configureBacktest({
  enabled: !OFF.has(String(process.env.OPS_JSONL_ENABLED ?? 'true').toLowerCase()),
  // Unset means <repo root>/logs — shared with the API, so one trace that
  // crosses from this process into that one stays in a single directory.
  dir: process.env.LOG_DIR || undefined,
  service: 'web-ssr',
})

// In dev, Vite injects CSS through the JS module graph, so the SSR'd HTML would
// paint unstyled until entry-client loads (FOUC + layout shift). Link the global
// stylesheet directly — the dev server serves /src/style.css as real CSS. In prod
// `vite build` already stamps a <link> for the entry CSS into index.html.
const devStyles = isProduction ? '' : '<link rel="stylesheet" href="/src/style.css">'

// Cached production assets
const templateHtml = isProduction
  ? await fs.readFile('./dist/client/index.html', 'utf-8')
  : ''
// The public reader's shell (docs/features/43): a second app in the same build.
const readerTemplateHtml = isProduction
  ? await fs.readFile('./dist/client/reader.html', 'utf-8')
  : ''

// `/s/<token>` and `/s/<token>/<documentId>` — a share link — and
// `/pub/<slug>/…` — a published site in path mode (docs/features/44). Kept in
// step with SHARE_PATH and SITE_PATH in src/entry-public.ts, which re-check them.
const PUBLIC_PATH = /^\/(?:s\/[^/?#]+(?:\/[^/?#]+)?\/?|pub\/[a-z0-9-]+(?:\/[^?#]*)?)(?:[?#].*)?$/

const API_INTERNAL = process.env.API_URL_INTERNAL ?? 'http://localhost:3000'

// Sites on their own host (docs/features/44): `<slug>.<PUBLISH_BASE_DOMAIN>`,
// the same variable the API reads (empty = path mode only), or a verified
// custom domain, asked of the API. The app's own host (WEB_BASE_URL) is never
// a site's and is never looked up.
const PUBLISH_BASE_DOMAIN = (process.env.PUBLISH_BASE_DOMAIN ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '')
const APP_HOST = (() => {
  try {
    return process.env.WEB_BASE_URL ? new URL(process.env.WEB_BASE_URL).hostname.toLowerCase() : null
  } catch {
    return null
  }
})()
const siteHostOf = createSiteHostResolver({ apiBase: API_INTERNAL, baseDomain: PUBLISH_BASE_DOMAIN, appHost: APP_HOST })

// Create http server
const app = express()

// Registered first, so Vite's middlewares and the SSR handler both run inside
// the scope and every response carries x-request-id — static asset 404s included.
app.use(traceMiddleware)

// Whose host is this? Decided once, before anything reads a cookie: a site's
// host is the public reader's all the way down.
app.use(async (req, res, next) => {
  try {
    res.locals.siteHost = await siteHostOf(req, forwardedFor(req))
  } catch {
    res.locals.siteHost = null
  }
  next()
})

// AI-readable URLs (issue #68): /documents/:id.md, Accept: text/markdown on
// /documents/:id, /llms.txt and the per-workspace/project llms files, proxied
// to the API. Mounted before Vite and the static handler so neither claims a
// `.md`/`.txt` path first, and in both branches (dev and production) alike.
const aiReadable = aiReadableMiddleware({ apiBase: API_INTERNAL, readCookie, logger })
// Not on a site's host: there, `/llms.txt` belongs to the site, not to the
// workspace a member's cookie would name.
app.use((req, res, next) => (res.locals.siteHost ? next() : aiReadable(req, res, next)))

// A site's sitemap.xml, robots.txt, llms(-full).txt and `<page>.md`, on its
// host or under /pub/<slug> (issue #77 phase 2b). Before Vite and sirv, like
// the AI-readable routes, so neither claims the path first.
app.use(siteFilesMiddleware({ apiBase: API_INTERNAL, forwardedFor, logger }))

// Add Vite or respective production middlewares
/** @type {import('vite').ViteDevServer | undefined} */
let vite
if (!isProduction) {
  const { createServer } = await import('vite')
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    base,
  })
  app.use(vite.middlewares)
} else {
  const compression = (await import('compression')).default
  const sirv = (await import('sirv')).default
  app.use(compression())
  app.use(base, sirv('./dist/client', { extensions: [] }))
}

const SUPPORTED_LOCALES = ['en', 'ru']

/**
 * Language for one render. The cookie is a decision the user made in this app;
 * Accept-Language is only the browser's default, so it loses to the cookie.
 * Matching is on the primary subtag, so `ru-RU` resolves to `ru`.
 */
function resolveLocale(cookie, acceptLanguage) {
  if (SUPPORTED_LOCALES.includes(cookie)) return cookie
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase()
    const primary = tag.split('-')[0]
    if (SUPPORTED_LOCALES.includes(primary)) return primary
  }
  return 'en'
}

/** Minimal cookie read — auth token, active scope and sidebar pane for the SSR pass. */
function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return null
}

/**
 * Only the share-unlock cookies, rebuilt as a Cookie header. A public render
 * must never carry `kn_token` to the API: the reader is anonymous even when
 * the person opening the link happens to be signed in to the app.
 */
function shareCookies(header) {
  if (!header) return ''
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => /^kn_share_[0-9a-f-]{36}=/i.test(part))
    .join('; ')
}

/** The visitor's address chain plus the peer, as Caddy would forward it to the API. */
function forwardedFor(req) {
  const prior = req.headers['x-forwarded-for']
  const peer = req.socket.remoteAddress
  return [typeof prior === 'string' ? prior : null, peer].filter(Boolean).join(', ') || null
}

/**
 * A share link (docs/features/43) or a published site (docs/features/44): the
 * public entry and its own shell. The render decides the headers — a share
 * carries no-referrer/noindex/no-store, a site its own robots rule — and may
 * answer with a redirect to a page's one canonical URL.
 */
async function renderPublic(req, res, url, siteHost) {
  let template
  let render
  if (!isProduction) {
    template = await fs.readFile('./reader.html', 'utf-8')
    template = await vite.transformIndexHtml(url, template)
    render = (await vite.ssrLoadModule('/src/entry-public.ts')).render
  } else {
    template = readerTemplateHtml
    render = (await import('./dist/server/entry-public.js')).render
  }
  const locale = resolveLocale(readCookie(req.headers.cookie, 'kn_lang'), req.headers['accept-language'])
  const headerTraceId = res.getHeader('x-request-id')
  let rendered
  try {
    rendered = await render(url, {
      locale,
      shareCookies: shareCookies(req.headers.cookie),
      forwardedFor: forwardedFor(req),
      traceId: typeof headerTraceId === 'string' ? headerTraceId : null,
      siteHost,
    })
  } catch (e) {
    // The API's per-address cap, passed on as itself rather than as a 500.
    if (e?.status === 429) {
      res.status(429).set({ 'Retry-After': '60', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Too Many Requests')
      return
    }
    throw e
  }
  if (rendered.redirect) {
    res.set(rendered.headers ?? {}).redirect(302, rendered.redirect)
    return
  }
  const html = template
    .replace(`<!--app-lang-->`, locale)
    .replace(`<!--app-css-->`, devStyles)
    .replace(`<!--app-head-->`, rendered.head ?? '')
    .replace(`<!--app-html-->`, rendered.html ?? '')
  res
    .status(rendered.status ?? 200)
    .set({ 'Content-Type': 'text/html', ...rendered.headers })
    .send(html)
}

// Serve HTML
app.use('*all', async (req, res) => {
  try {
    const url = req.originalUrl.replace(base, '')
    // Checked first, before any cookie is read: a public render takes nothing
    // from the member app's request context.
    const siteHost = res.locals.siteHost
    if (siteHost || PUBLIC_PATH.test(req.originalUrl)) {
      await renderPublic(req, res, req.originalUrl, siteHost)
      return
    }

    /** @type {string} */
    let template
    /** @type {import('./src/entry-server.ts').render} */
    let render
    if (!isProduction) {
      // Always read fresh template in development
      template = await fs.readFile('./index.html', 'utf-8')
      template = await vite.transformIndexHtml(url, template)
      render = (await vite.ssrLoadModule('/src/entry-server.ts')).render
    } else {
      template = templateHtml
      render = (await import('./dist/server/entry-server.js')).render
    }

    // Language for this render (docs/features/18): the user's own choice first
    // (kn_lang mirrors users.locale), then whatever the browser asks for, then
    // English. Resolved here so the SSR HTML is already in the right language
    // rather than flashing English and swapping after hydration.
    const locale = resolveLocale(readCookie(req.headers.cookie, 'kn_lang'), req.headers['accept-language'])

    // Set by traceMiddleware on the way in. Handing it to the render is what
    // puts the browser's request, this render, and every API call the render
    // makes onto one trace id.
    const headerTraceId = res.getHeader('x-request-id')

    const rendered = await render(url, {
      token: readCookie(req.headers.cookie, 'kn_token'),
      projectId: readCookie(req.headers.cookie, 'kn_proj'),
      pane: readCookie(req.headers.cookie, 'kn_pane'),
      rail: readCookie(req.headers.cookie, 'kn_rail'),
      railOpen: readCookie(req.headers.cookie, 'kn_railopen'),
      filterRail: readCookie(req.headers.cookie, 'kn_filterrail'),
      glossary: readCookie(req.headers.cookie, 'kn_glossary'),
      aiPanel: readCookie(req.headers.cookie, 'kn_aipanel'),
      treeOpen: readCookie(req.headers.cookie, 'kn_tree'),
      workspaceId: readCookie(req.headers.cookie, 'kn_ws'),
      locale,
      traceId: typeof headerTraceId === 'string' ? headerTraceId : null,
    })

    const html = template
      .replace(`<!--app-lang-->`, locale)
      .replace(`<!--app-css-->`, devStyles)
      .replace(`<!--app-head-->`, rendered.head ?? '')
      .replace(`<!--app-html-->`, rendered.html ?? '')

    res.status(200).set({ 'Content-Type': 'text/html' }).send(html)
  } catch (e) {
    vite?.ssrFixStacktrace(e)
    // The stack goes to the log, never to the client. This used to send the
    // server's stack trace as the response body, which hands anyone who can
    // trigger a render error the internal paths and dependency layout.
    logger.error({ msg: 'SSR render failed', route: req.originalUrl, err: e })
    res.status(500).set({ 'Content-Type': 'text/plain' }).end('Internal Server Error')
  }
})

// Start http server
app.listen(port, () => {
  logger.info({ port }, `Server started at http://localhost:${port}`)
})
