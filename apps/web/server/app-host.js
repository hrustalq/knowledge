// The member app's own host (issue #277): its security headers and its
// robots.txt. A published site's host and the public paths (`/s/…`, `/pub/…`)
// are not the app's — their renders and files set their own headers, and a
// site's Ask frame must stay embeddable wherever its `frame-ancestors` allows.
//
// Plain JS on purpose: server.js is unbundled Node, and Dockerfile.web copies
// this directory next to it.

/** The Content-Security-Policy goes alongside these, from appContentSecurityPolicy. */
export const APP_SECURITY_HEADERS = {
  // No includeSubDomains: sites may one day sit under the app's own domain.
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // The browsers' default, stated like the rest (#645).
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

// The member app is behind a sign-in and is no crawler's business. Sites in
// path mode live under /pub/ on this same host — the only way production
// serves them (docs/features/44) — so they stay crawlable; a site that is not
// indexable says `noindex` on its own pages.
export const APP_ROBOTS_TXT = 'User-agent: *\nAllow: /pub/\nDisallow: /\n'

/**
 * The member app's first policy (#1099). Nonce-free, so the inline SSR state
 * script, Vite dev and the service worker are untouched: no `default-src` or
 * `script-src` yet (they need nonces, #277), and no `img-src` until external
 * images in pages go through a proxy — model output already drops remote
 * images itself (MarkdownView's `untrusted`). What it closes is what a
 * sanitizer gap reaches for first: a form posting elsewhere, a `<base>`
 * retargeting every relative URL, a plugin frame, the app framed.
 *
 * @param {string[]} assetOrigins origins presigned attachment URLs live on, when not the app's own (dev MinIO)
 * @returns {string}
 */
export function appContentSecurityPolicy(assetOrigins = []) {
  for (const origin of assetOrigins) {
    if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) throw new Error(`Not a CSP origin: ${origin}`)
  }
  return [
    "base-uri 'none'",
    "form-action 'self'",
    // The PDF preview is the one <object> the app draws, from a presigned URL.
    ["object-src 'self'", ...assetOrigins].join(' '),
    // X-Frame-Options, stated the way current browsers read it.
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * @param {RegExp} publicPath server.js's PUBLIC_PATH: share links and path-mode sites
 * @param {{ assetOrigins?: string[] }} [options]
 * @returns {import('express').RequestHandler}
 */
export function appHostMiddleware(publicPath, { assetOrigins = [] } = {}) {
  const headers = { ...APP_SECURITY_HEADERS, 'Content-Security-Policy': appContentSecurityPolicy(assetOrigins) }
  return (req, res, next) => {
    if (res.locals.siteHost || publicPath.test(req.originalUrl)) return next()
    res.set(headers)
    if (req.path === '/robots.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
      return res.send(APP_ROBOTS_TXT)
    }
    next()
  }
}
