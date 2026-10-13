import { describe, expect, it, vi } from 'vitest'
import { WIDGET_MESSAGE_SOURCE, WIDGET_SCRIPT, isWidgetScript, siteWidgetRoute } from './site-widget.js'

/**
 * The embed script (issue #77 phase 3). What is pinned: it is served only at
 * a site's `/widget.js` (host mode) or `/pub/<slug>/widget.js`, as cacheable
 * cross-origin JavaScript; it is valid script; it derives its frame from its
 * own URL; and it believes messages from that frame's origin only.
 */

const req = (path, method = 'GET') => ({ path, method })

describe('isWidgetScript', () => {
  it('matches the script on a site host and under /pub/<slug>/, nowhere else', () => {
    expect(isWidgetScript(req('/widget.js'), 'docs.example.com')).toBe(true)
    expect(isWidgetScript(req('/pub/acme/widget.js'), null)).toBe(true)
    expect(isWidgetScript(req('/widget.js'), null)).toBe(false)
    expect(isWidgetScript(req('/pub/acme/guides/widget.js'), null)).toBe(false)
    expect(isWidgetScript(req('/pub/acme/widget.js', 'POST'), null)).toBe(false)
  })
})

describe('siteWidgetRoute', () => {
  it('answers with the script and passes everything else on', () => {
    const route = siteWidgetRoute()
    const res = { locals: { siteHost: null }, status: vi.fn(() => res), set: vi.fn(() => res), send: vi.fn(() => res) }
    const next = vi.fn()
    route(req('/pub/acme/widget.js'), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }))
    expect(res.send).toHaveBeenCalledWith(WIDGET_SCRIPT)
    route(req('/pub/acme/guides'), res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('WIDGET_SCRIPT', () => {
  it('parses as script', () => {
    expect(() => new Function(WIDGET_SCRIPT)).not.toThrow()
  })

  it('opens the frame beside itself and trusts that frame only', () => {
    expect(WIDGET_SCRIPT).toContain(`replace(/widget\\.js$/, '_widget')`)
    expect(WIDGET_SCRIPT).toContain('e.origin !== frameUrl.origin || e.source !== frame.contentWindow')
    expect(WIDGET_SCRIPT).toContain(JSON.stringify(WIDGET_MESSAGE_SOURCE))
    // Nothing from a message lands in markup.
    expect(WIDGET_SCRIPT).not.toMatch(/innerHTML/)
  })
})
