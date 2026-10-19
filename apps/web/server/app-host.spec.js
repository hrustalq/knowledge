import { describe, expect, it, vi } from 'vitest'
import { APP_ROBOTS_TXT, APP_SECURITY_HEADERS, appHostMiddleware } from './app-host.js'

/**
 * The app host (issue #277). What is pinned: the security headers go on the
 * app's own responses and nowhere public; robots.txt keeps crawlers out of the
 * member app but not out of path-mode sites; a site host's robots.txt is left
 * to the site.
 */

// server.js's PUBLIC_PATH.
const PUBLIC_PATH = /^\/(?:s\/[^/?#]+(?:\/[^/?#]+)?\/?|pub\/[a-z0-9-]+(?:\/[^?#]*)?)(?:[?#].*)?$/

function run(path, { siteHost = null, method = 'GET' } = {}) {
  const res = { locals: { siteHost }, set: vi.fn(() => res), send: vi.fn(() => res) }
  const next = vi.fn()
  appHostMiddleware(PUBLIC_PATH)({ path: path.split('?')[0], originalUrl: path, method }, res, next)
  return { res, next }
}

describe('appHostMiddleware', () => {
  it('sets the security headers on app pages and passes them on', () => {
    const { res, next } = run('/documents?q=x')
    expect(res.set).toHaveBeenCalledWith(APP_SECURITY_HEADERS)
    expect(next).toHaveBeenCalled()
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
