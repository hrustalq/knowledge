import fs from 'node:fs/promises'
import express from 'express'
import { configureBacktest, createRootLogger, envLogLevel } from '@knowledge/observability'
import { traceMiddleware } from '@knowledge/observability/express'
import { aiReadableMiddleware } from './server/ai-readable.js'
import { appHostMiddleware } from './server/app-host.js'
import { createRenderCache, renderCacheKey } from './server/render-cache.js'
import { createSiteHostResolver, siteFilesMiddleware } from './server/site-files.js'
import { siteWidgetRoute } from './server/site-widget.js'
import { exportRenderRoute } from './server/export-render.js'

// Vue's compile-time flags. The SSR bundles leave `vue-i18n` external, so
// Node loads its esm build unreplaced, and its plugin install() reads
// `__VUE_PROD_DEVTOOLS__` whenever NODE_ENV is production. Nothing defines it
// under plain Node unless some other module happens to first: a member-app
// render did, so a public page rendered first after boot threw inside the
// async install(), and the unhandled rejection killed the process.
globalThis.__VUE_PROD_DEVTOOLS__ ??= false

// Constants
const isProduction = process.env.NODE_ENV === 'production'
const port = process.env.PORT || 5173
const base = process.env.BASE || '/'

// The same logger apps/api runs, so an SSR render and the API request it makes
// land in one stream under one trace id. This process previously wrote nothing
// but bare console.log, which made an SSR failure unattributable to the page
// that caused it.
const logger = createRootLogger({ service: 'web-ssr', level: envLogLevel() })

// A page that fires a request without awaiting it (`void store.fetchX()` in an
// immediate watcher) runs that request during SSR too, and a refusal there is
// an unhandled rejection — which Node answers by killing the process, and
// every render with it. An API refusal (a 4xx — say a workspace that enforces
// SSO answering a password session, #75) is data about one request, not about
// this process: log it and carry on; the browser repeats the request after
// hydration and handles it (lib/reauth.ts). Anything else is a real bug and
// still crashes, as Node intends.
process.on('unhandledRejection', (reason) => {
  const status = typeof reason === 'object' && reason !== null ? reason.status : undefined
  if (typeof status === 'number' && status >= 400 && status < 500) {
    logger.warn({ msg: 'unawaited API request refused during SSR', status, err: reason })
    return
  }
  throw reason
})
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

// Published site pages, kept by host + language + URL and revalidated with the
// API on every request (issue #77 phase 2b-2). 0 turns it off.
const SITE_RENDER_CACHE_MB = Number(process.env.SITE_RENDER_CACHE_MB ?? 32)
const renderCache = createRenderCache({
  maxBytes: (Number.isFinite(SITE_RENDER_CACHE_MB) ? Math.max(0, SITE_RENDER_CACHE_MB) : 32) * 1024 * 1024,
})

// Create http server
const app = express()

// Registered first, so Vite's middlewares and the SSR handler both run inside
// the scope and every response carries x-request-id — static asset 404s included.
app.use(traceMiddleware)

// The worker's export renderer (docs/features/45), before anything that reads
// a host or a cookie: it is a call from inside the network, not a page view.
app.use(
  exportRenderRoute({
    express,
    logger,
    loadRenderer: async () =>
      isProduction
        ? (await import('./dist/server/export-render.js')).renderExport
        : (await vite.ssrLoadModule('/src/export-render.ts')).renderExport,
  }),
)

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

// The app host's security headers and robots.txt (issue #277). A site's host
// and the public paths keep whatever their own handlers set.
app.use(appHostMiddleware(PUBLIC_PATH))

// A site's embeddable Ask widget script (issue #77 phase 3): `/widget.js` on
// its host or `/pub/<slug>/widget.js`, before the reader takes it for a page.
app.use(siteWidgetRoute())

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
  // Vite content-hashes everything under assets/, so a changed file is a new
  // URL: those are cached for a year. The rest (favicon, the HTML shells) keep
  // their names across releases and are revalidated on every use (#277).
  app.use(`${base}assets`, sirv('./dist/client/assets', { maxAge: 31536000, immutable: true }))
  app.use(base, sirv('./dist/client', { extensions: [], maxAge: 0, etag: true }))
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
 * Only the share-unlock and site sign-in cookies, rebuilt as a Cookie header.
 * A public render must never carry `kn_token` to the API: the reader is
 * anonymous even when the person opening the link happens to be signed in to
 * the app. A site sign-in (`kn_site_<id>`, issue #77 phase 3) is the site's
 * own session, opened on the site's origin for that site alone.
 */
function shareCookies(header) {
  if (!header) return ''
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => /^kn_(?:share|site)_[0-9a-f-]{36}=/i.test(part))
    .join('; ')
}

/** Does the request carry a site sign-in? Its render is that reader's, never the shared one. */
function hasSiteSession(header) {
  return !!header && /(?:^|;\s*)kn_site_[0-9a-f-]{36}=/i.test(header)
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
  // A signed-in reader may see pages others do not. The API's ETag already
  // tells the renders apart, but caching them here would only evict the
  // anonymous render everyone else shares.
  const cacheKey = renderCache.enabled && !hasSiteSession(req.headers.cookie) ? renderCacheKey({ siteHost, url, locale }) : null
  const cached = cacheKey ? renderCache.get(cacheKey) : null
  let rendered
  try {
    rendered = await render(url, {
      locale,
      shareCookies: shareCookies(req.headers.cookie),
      forwardedFor: forwardedFor(req),
      traceId: typeof headerTraceId === 'string' ? headerTraceId : null,
      siteHost,
      ifNoneMatch: cached?.etag ?? null,
    })
    // The API vouched for the cached render: the site is still live and the
    // page is what it was. Anything else replaces or drops the entry.
    if (rendered.notModified && cached) rendered = cached.rendered
    else if (cacheKey && rendered.etag) renderCache.set(cacheKey, rendered.etag, rendered)
    else if (cacheKey && cached) renderCache.delete(cacheKey)
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
      measure: readCookie(req.headers.cookie, 'kn_measure'),
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

    // One member's render, behind their cookie: never a shared cache's, and
    // never reused without asking.
    res.status(200).set({ 'Content-Type': 'text/html', 'Cache-Control': 'private, no-cache' }).send(html)
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
