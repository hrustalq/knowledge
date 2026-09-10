import fs from 'node:fs/promises'
import express from 'express'

// Constants
const isProduction = process.env.NODE_ENV === 'production'
const port = process.env.PORT || 5173
const base = process.env.BASE || '/'

// In dev, Vite injects CSS through the JS module graph, so the SSR'd HTML would
// paint unstyled until entry-client loads (FOUC + layout shift). Link the global
// stylesheet directly — the dev server serves /src/style.css as real CSS. In prod
// `vite build` already stamps a <link> for the entry CSS into index.html.
const devStyles = isProduction ? '' : '<link rel="stylesheet" href="/src/style.css">'

// Cached production assets
const templateHtml = isProduction
  ? await fs.readFile('./dist/client/index.html', 'utf-8')
  : ''

// Create http server
const app = express()

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

// Serve HTML
app.use('*all', async (req, res) => {
  try {
    const url = req.originalUrl.replace(base, '')

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

    const rendered = await render(url, {
      token: readCookie(req.headers.cookie, 'kn_token'),
      projectId: readCookie(req.headers.cookie, 'kn_proj'),
      pane: readCookie(req.headers.cookie, 'kn_pane'),
      rail: readCookie(req.headers.cookie, 'kn_rail'),
      railOpen: readCookie(req.headers.cookie, 'kn_railopen'),
      filterRail: readCookie(req.headers.cookie, 'kn_filterrail'),
      glossary: readCookie(req.headers.cookie, 'kn_glossary'),
      treeOpen: readCookie(req.headers.cookie, 'kn_tree'),
      workspaceId: readCookie(req.headers.cookie, 'kn_ws'),
      locale,
    })

    const html = template
      .replace(`<!--app-lang-->`, locale)
      .replace(`<!--app-css-->`, devStyles)
      .replace(`<!--app-head-->`, rendered.head ?? '')
      .replace(`<!--app-html-->`, rendered.html ?? '')

    res.status(200).set({ 'Content-Type': 'text/html' }).send(html)
  } catch (e) {
    vite?.ssrFixStacktrace(e)
    console.log(e.stack)
    res.status(500).end(e.stack)
  }
})

// Start http server
app.listen(port, () => {
  console.log(`Server started at http://localhost:${port}`)
})
