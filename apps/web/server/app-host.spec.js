import { describe, expect, it, vi } from 'vitest'
import { APP_ROBOTS_TXT, APP_SECURITY_HEADERS, appContentSecurityPolicy, appHostMiddleware } from './app-host.js'

/**
 * The app host (issue #277). What is pinned: the security headers go on the
 * app's own responses and nowhere public; robots.txt keeps crawlers out of the
 * member app but not out of path-mode sites; a site host's robots.txt is left
 * to the site.
 */

// server.js's PUBLIC_PATH.
const PUBLIC_PATH = /^\/(?:s\/[^/?#]+(?:\/[^/?#]+)?\/?|pub\/[a-z0-9-]+(?:\/[^?#]*)?)(?:[?#].*)?$/

function run(path, { siteHost = null, method = 'GET', assetOrigins } = {}) {
  const res = { locals: { siteHost }, set: vi.fn(() => res), send: vi.fn(() => res) }
  const next = vi.fn()
  appHostMiddleware(PUBLIC_PATH, { assetOrigins })({ path: path.split('?')[0], originalUrl: path, method }, res, next)
  return { res, next }
}

/** The directives of a policy, by name. */
const directives = (policy) =>
  Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))

describe('appHostMiddleware', () => {
  it('sets the security headers on app pages and passes them on', () => {
    const { res, next } = run('/documents?q=x')
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining(APP_SECURITY_HEADERS))
    expect(next).toHaveBeenCalled()
  })

  // #1099: a first policy, nonce-free, so the inline SSR state script and Vite
  // dev keep working. It closes what a sanitizer gap would reach for first.
  it('sends a Content-Security-Policy on app pages', () => {
    const { res } = run('/documents/x')
    const policy = res.set.mock.calls[0][0]['Content-Security-Policy']
    expect(policy).toBeTruthy()
    const d = directives(policy)
    expect(d['base-uri']).toEqual(["'none'"])
    expect(d['form-action']).toEqual(["'self'"])
    expect(d['object-src']).toEqual(["'self'"])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    // Not yet: script-src needs nonces for the inline scripts, img-src an image proxy.
    expect(d['script-src']).toBeUndefined()
    expect(d['default-src']).toBeUndefined()
    expect(d['img-src']).toBeUndefined()
  })

  it('lets PDFs preview from the asset origins it is given (presigned URLs off the app origin)', () => {
    const { res } = run('/documents/x', { assetOrigins: ['http://localhost:9000'] })
    expect(directives(res.set.mock.calls[0][0]['Content-Security-Policy'])['object-src']).toEqual(["'self'", 'http://localhost:9000'])
  })

  it('refuses an asset origin that would break the header', () => {
    expect(() => appContentSecurityPolicy(["http://x; script-src 'unsafe-inline'"])).toThrow()
    expect(() => appContentSecurityPolicy(['javascript:alert(1)'])).toThrow()
  })

  it('leaves share links, path-mode sites and site hosts alone', () => {
    for (const [path, opts] of [['/s/abc'], ['/pub/acme/_widget'], ['/pub/acme/robots.txt'], ['/robots.txt', { siteHost: 'docs.example.com' }]]) {
      const { res, next } = run(path, opts)
      expect(res.set).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    }
  })

  it('answers robots.txt as plain text that still lets crawlers into /pub/', () => {
    const { res, next } = run('/robots.txt')
    expect(next).not.toHaveBeenCalled()
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'text/plain; charset=utf-8' }))
    expect(res.send).toHaveBeenCalledWith(APP_ROBOTS_TXT)
    expect(APP_ROBOTS_TXT).toMatch(/^Allow: \/pub\/$/m)
    expect(APP_ROBOTS_TXT).toMatch(/^Disallow: \/$/m)
  })
})
