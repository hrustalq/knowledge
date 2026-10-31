// The member app's own host (issue #277): its security headers and its
// robots.txt. A published site's host and the public paths (`/s/…`, `/pub/…`)
// are not the app's — their renders and files set their own headers, and a
// site's Ask frame must stay embeddable wherever its `frame-ancestors` allows.
//
// Plain JS on purpose: server.js is unbundled Node, and Dockerfile.web copies
// this directory next to it.

/** No Content-Security-Policy yet: it needs nonces for the inline scripts (#277, out of scope). */
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
 * @param {RegExp} publicPath server.js's PUBLIC_PATH: share links and path-mode sites
 * @returns {import('express').RequestHandler}
 */
export function appHostMiddleware(publicPath) {
  return (req, res, next) => {
    if (res.locals.siteHost || publicPath.test(req.originalUrl)) return next()
    res.set(APP_SECURITY_HEADERS)
    if (req.path === '/robots.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
      return res.send(APP_ROBOTS_TXT)
    }
    next()
  }
}
