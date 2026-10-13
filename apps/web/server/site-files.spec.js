// Site hosts and a site's machine-readable files (issue #77 phase 2b).
// Plain JS like the module under test: server/ is unbundled Node, outside the
// app's tsconfig.

import { once } from 'node:events'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createSiteHostResolver, isInternalAddress, requestHost, siteFileFor, siteFilesMiddleware } from './site-files.js'

const req = (host, { forwardedHost, peer = '203.0.113.9' } = {}) => ({
  headers: { host, ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}) },
  socket: { remoteAddress: peer },
})

describe('requestHost', () => {
  it('reads Host, without its port or trailing dot', () => {
    expect(requestHost(req('Docs.Acme.com.:443'))).toBe('docs.acme.com')
  })

  it('believes X-Forwarded-Host only from an internal peer', () => {
    expect(requestHost(req('mini.ts.net', { forwardedHost: 'docs.acme.com', peer: '172.18.0.5' }))).toBe('docs.acme.com')
    expect(requestHost(req('mini.ts.net', { forwardedHost: 'docs.acme.com, x', peer: '::ffff:127.0.0.1' }))).toBe('docs.acme.com')
    expect(requestHost(req('kb.example.com', { forwardedHost: 'docs.acme.com', peer: '203.0.113.9' }))).toBe('kb.example.com')
  })

  it('agrees with the API on what is internal', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '::1', 'fd00::1']) expect(isInternalAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', undefined]) expect(isInternalAddress(ip)).toBe(false)
  })
})

describe('createSiteHostResolver', () => {
  function resolver(answer = () => 404, opts = {}) {
    const calls = []
    let clock = 0
    const of = createSiteHostResolver({
      apiBase: 'http://api.test/',
      baseDomain: 'docs.example.com',
      appHost: 'kb.example.com',
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers })
        const status = answer(url)
        if (status instanceof Error) throw status
        return new Response('{}', { status })
      },
      now: () => clock,
      ...opts,
    })
    return { of, calls, tick: (ms) => (clock += ms) }
  }

  it('knows a base-domain subdomain by its shape, without asking', async () => {
    const { of, calls } = resolver()
    expect(await of(req('acme.docs.example.com'), null)).toBe('acme.docs.example.com')
    expect(await of(req('a.b.docs.example.com'), null)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('never asks about the app’s own host, localhost or an address', async () => {
    const { of, calls } = resolver(() => 200)
    for (const host of ['kb.example.com', 'localhost:5173', '127.0.0.1:5173', 'app.localhost']) expect(await of(req(host), null)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('asks the API about any other host, with the visitor’s address, and remembers the answer for a minute', async () => {
    const { of, calls, tick } = resolver((url) => (url.includes('docs.acme.com') ? 200 : 404))
    expect(await of(req('docs.acme.com'), '198.51.100.7')).toBe('docs.acme.com')
    expect(calls[0].url).toBe('http://api.test/v1/public/domains/allow?domain=docs.acme.com')
    expect(calls[0].headers['x-forwarded-for']).toBe('198.51.100.7')
    expect(await of(req('evil.example.org'), null)).toBeNull()
    expect(await of(req('docs.acme.com'), null)).toBe('docs.acme.com')
    expect(await of(req('evil.example.org'), null)).toBeNull()
    expect(calls).toHaveLength(2)
    tick(61_000)
    await of(req('docs.acme.com'), null)
    expect(calls).toHaveLength(3)
  })

  it('does not remember a failed lookup, and treats it as the app for that request', async () => {
    let status = 429
    const { of, calls } = resolver(() => status)
    expect(await of(req('docs.acme.com'), null)).toBeNull()
    status = 200
    expect(await of(req('docs.acme.com'), null)).toBe('docs.acme.com')
    expect(calls).toHaveLength(2)
    const down = resolver(() => new Error('ECONNREFUSED'))
    expect(await down.of(req('docs.acme.com'), null)).toBeNull()
  })

  it('keeps at most maxEntries hosts, dropping the oldest', async () => {
    const { of, calls } = resolver(() => 404, { maxEntries: 2 })
    for (const h of ['a.example.org', 'b.example.org', 'c.example.org', 'a.example.org']) await of(req(h), null)
    expect(calls).toHaveLength(4) // `a` was evicted by `c`, so it is asked again
  })
})

describe('siteFileFor', () => {
  it('maps the site’s file paths to their API routes, and leaves pages to the reader', () => {
    expect(siteFileFor('/sitemap.xml')).toEqual({ route: 'sitemap.xml', params: {} })
    expect(siteFileFor('/robots.txt')).toEqual({ route: 'robots.txt', params: {} })
    expect(siteFileFor('/llms.txt')).toEqual({ route: 'llms.txt', params: {} })
    expect(siteFileFor('/v1.2/llms-full.txt')).toEqual({ route: 'llms-full.txt', params: { version: 'v1.2' } })
    expect(siteFileFor('/guides/install.md')).toEqual({ route: 'markdown', params: { path: 'guides/install' } })
    expect(siteFileFor('/index.md')).toEqual({ route: 'markdown', params: { path: 'index' } })
    for (const page of ['/', '/guides/install', '/v1/sitemap.xml', '/a/b/llms.txt', '/.md', undefined]) expect(siteFileFor(page)).toBeNull()
  })
})

// --- the middleware over a real Express server and a fake upstream ---------

let server
afterEach(() => server?.close())

async function start(upstream, siteHost = null) {
  const calls = []
  const app = express()
  app.use((_req, res, next) => {
    res.locals.siteHost = siteHost
    next()
  })
  app.use(
    siteFilesMiddleware({
      apiBase: 'http://api.test',
      forwardedFor: () => '198.51.100.7',
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers })
        return upstream(url, init)
      },
    }),
  )
  app.use((_req, res) => res.status(200).send('<html>reader</html>'))
  server = app.listen(0)
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${server.address().port}`, calls }
}

const text = (body, headers = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', etag: '"e1"', ...headers } })

describe('siteFilesMiddleware', () => {
  it('serves a site host’s files from the API, and never its cookies or credentials', async () => {
    const { base, calls } = await start(() => text('User-agent: *\n'), 'docs.acme.com')
    const res = await fetch(`${base}/robots.txt`, { headers: { cookie: 'kn_token=ks_secret', authorization: 'Bearer kn_x', 'if-none-match': '"e0"' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('User-agent: *\n')
    expect(res.headers.get('etag')).toBe('"e1"')
    expect(calls[0].url).toBe('http://api.test/v1/public/sites/robots.txt?host=docs.acme.com')
    expect(calls[0].headers).toMatchObject({ 'x-forwarded-for': '198.51.100.7', 'if-none-match': '"e0"' })
    expect(Object.keys(calls[0].headers)).not.toContain('cookie')
    expect(Object.keys(calls[0].headers)).not.toContain('authorization')
  })

  it('serves path mode under /pub/<slug>, and a page’s markdown by its path', async () => {
    const { base, calls } = await start(() => text('# Install\n'))
    await fetch(`${base}/pub/acme/v1/guides/%D1%83.md`)
    expect(calls[0].url).toBe('http://api.test/v1/public/sites/markdown?path=v1%2Fguides%2F%25D1%2583&slug=acme')
    await fetch(`${base}/pub/acme/sitemap.xml`)
    expect(calls[1].url).toBe('http://api.test/v1/public/sites/sitemap.xml?slug=acme')
  })

  it('leaves pages, the app’s own paths, and other methods to the next handler', async () => {
    const { base, calls } = await start(() => text('x'))
    expect(await (await fetch(`${base}/pub/acme/guides`)).text()).toBe('<html>reader</html>')
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toBe('<html>reader</html>') // not a site host
    expect(await (await fetch(`${base}/pub/acme/robots.txt`, { method: 'POST' })).text()).toBe('<html>reader</html>')
    expect(calls).toHaveLength(0)
  })

  it('passes a 404 on as one plain-text line, and a 304 with no body', async () => {
    const missing = await start(() => new Response(JSON.stringify({ statusCode: 404, message: 'Site not found' }), { status: 404 }), 'docs.acme.com')
    const res = await fetch(`${missing.base}/sitemap.xml`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('404 Site not found\n')
    server.close()
    const same = await start(() => new Response(null, { status: 304, headers: { etag: '"e1"' } }), 'docs.acme.com')
    const cached = await fetch(`${same.base}/llms.txt`, { headers: { 'if-none-match': '"e1"' } })
    expect(cached.status).toBe(304)
  })
})
