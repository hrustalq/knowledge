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
 * Where the member app's own UI (not page content) shows a third party's
 * picture: a connection's account avatar, the GitHub installation and repo
 * picker, a Figma frame thumbnail in the embed picker. Page images never need
 * this list — they come through the image proxy (#1133). A self-hosted GitLab
 * or Jira's avatars are the operator's to add (CSP_IMAGE_ORIGINS).
 */
export const THIRD_PARTY_IMAGE_SOURCES = [
  'https://avatars.githubusercontent.com', // GitHub
  'https://gitlab.com', // GitLab.com uploads
  'https://secure.gravatar.com', // GitLab and Atlassian fall back to Gravatar
  'https://www.gravatar.com',
  'https://*.atl-paas.net', // Atlassian account avatars
  'https://s3-us-west-2.amazonaws.com/public.notion-static.com/', // Notion, path-scoped: the host is all of S3
  'https://public.linear.app', // Linear
  'https://*.zendesk.com', // Zendesk profile photos
  'https://*.figma.com', // Figma avatars
  'https://figma-alpha-api.s3.us-west-2.amazonaws.com', // Figma frame thumbnails
]

/**
 * The member app's policy (#1099). Nonce-free, so the inline SSR state script,
 * Vite dev and the service worker are untouched: no `default-src` or
 * `script-src` yet (they need nonces, #277). What it closes is what a
 * sanitizer gap reaches for first: a form posting elsewhere, a `<base>`
 * retargeting every relative URL, a plugin frame, the app framed, and an image
 * loaded from a host that logs who read the page — page images load through
 * the image proxy on the app's own origin (#1133), model output keeps none.
 *
 * @param {string[]} assetOrigins origins presigned attachment URLs live on, when not the app's own (dev MinIO)
 * @param {string[]} imageOrigins more origins the app's own UI shows pictures from (a self-hosted GitLab's avatars)
 * @returns {string}
 */
export function appContentSecurityPolicy(assetOrigins = [], imageOrigins = []) {
  assertOrigins(imageOrigins)
  return [
    ...baseDirectives(assetOrigins),
    // blob: is a picture being uploaded, previewed before it is stored.
    ["img-src 'self' data: blob:", ...assetOrigins, ...THIRD_PARTY_IMAGE_SOURCES, ...imageOrigins].join(' '),
    // X-Frame-Options, stated the way current browsers read it.
    "frame-ancestors 'none'",
  ].join('; ')
}

/** @param {string[]} origins */
function assertOrigins(origins) {
  for (const origin of origins) {
    if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) throw new Error(`Not a CSP origin: ${origin}`)
  }
}

/** @param {string[]} assetOrigins */
function baseDirectives(assetOrigins) {
  assertOrigins(assetOrigins)
  return [
    "base-uri 'none'",
    "form-action 'self'",
    // The PDF preview is the one <object> the app (and the public renderer) draws, from a presigned URL.
    ["object-src 'self'", ...assetOrigins].join(' '),
  ]
}

/**
 * A share link's or published site's response headers (#1142): the render's
 * own, plus `nosniff` and the app's three directives. The frame policy is the
 * render's when it states one — the Ask widget lists who may frame it — and
 * `'none'` otherwise. No `img-src`: the image proxy needs a session, which a
 * share link's or site's reader does not have (#1133).
 *
 * @param {string[]} assetOrigins
 * @param {Record<string, string> | undefined} renderHeaders
 * @returns {Record<string, string>}
 */
export function publicResponseHeaders(assetOrigins, renderHeaders) {
  const frame = renderHeaders?.['Content-Security-Policy']?.match(/frame-ancestors[^;]*/)?.[0].trim() ?? "frame-ancestors 'none'"
  return {
    ...renderHeaders,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': [...baseDirectives(assetOrigins), frame].join('; '),
  }
}

/**
 * @param {RegExp} publicPath server.js's PUBLIC_PATH: share links and path-mode sites
 * @param {{ assetOrigins?: string[], imageOrigins?: string[] }} [options]
 * @returns {import('express').RequestHandler}
 */
export function appHostMiddleware(publicPath, { assetOrigins = [], imageOrigins = [] } = {}) {
  const headers = { ...APP_SECURITY_HEADERS, 'Content-Security-Policy': appContentSecurityPolicy(assetOrigins, imageOrigins) }
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
