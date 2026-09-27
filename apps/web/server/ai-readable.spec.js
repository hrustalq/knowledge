// Accept parsing, path matching and the pass-through (issue #68, phase 3).
// Plain JS like the module under test: server/ is unbundled Node, outside the
// app's tsconfig.

import { once } from 'node:events'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import {
  aiReadableMiddleware,
  apiPathFor,
  forwardedAuthorization,
  parseAccept,
  prefersMarkdown,
} from './ai-readable.js'

const ID = '3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f'
const P = '0c9d8e7f-6a5b-4c3d-9e1f-2a3b4c5d6e7f'

describe('parseAccept', () => {
  it('reads types and q-values, defaulting q to 1', () => {
    expect(parseAccept('text/markdown;q=0.9, text/html;q=0.8, */*')).toEqual([
      { type: 'text/markdown', q: 0.9 },
      { type: 'text/html', q: 0.8 },
      { type: '*/*', q: 1 },
    ])
  })

  it('treats an unreadable q as 0 and skips empty entries', () => {
    expect(parseAccept('text/markdown;q=abc, ,text/html')).toEqual([
      { type: 'text/markdown', q: 0 },
      { type: 'text/html', q: 1 },
    ])
  })

  it('is empty for a missing header', () => {
    expect(parseAccept(undefined)).toEqual([])
  })
})

describe('prefersMarkdown', () => {
  it.each([
    ['text/markdown', true],
    ['text/markdown;q=0.9, text/html;q=0.8', true],
    ['text/markdown, */*;q=0.1', true],
    ['TEXT/Markdown', true],
    // A browser keeps the SSR page.
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', false],
    // curl's default: a wildcard never selects markdown on its own.
    ['*/*', false],
    ['text/*', false],
    [undefined, false],
    // Tie goes to HTML.
    ['text/markdown, text/html', false],
    ['text/html;q=0.5, text/markdown;q=0.5', false],
    ['text/markdown;q=0', false],
    // text/* at 0.9 ranks html above markdown's 0.5.
    ['text/markdown;q=0.5, text/*;q=0.9', false],
  ])('%s → %s', (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected)
  })
})

describe('apiPathFor', () => {
  it('maps a .md page regardless of Accept', () => {
    expect(apiPathFor(`/documents/${ID}.md`, 'text/html')).toBe(`/v1/documents/${ID}/markdown`)
  })

  it('lower-cases the id', () => {
    expect(apiPathFor(`/documents/${ID.toUpperCase()}.md`, undefined)).toBe(`/v1/documents/${ID}/markdown`)
  })

  it('negotiates the page URL only when markdown is preferred', () => {
    expect(apiPathFor(`/documents/${ID}`, 'text/markdown')).toBe(`/v1/documents/${ID}/markdown`)
    expect(apiPathFor(`/documents/${ID}/`, 'text/markdown')).toBe(`/v1/documents/${ID}/markdown`)
    expect(apiPathFor(`/documents/${ID}`, 'text/html,*/*;q=0.8')).toBeNull()
  })

  it('maps the llms files', () => {
    expect(apiPathFor('/llms.txt', undefined)).toBe('/v1/llms.txt')
    expect(apiPathFor(`/workspaces/${ID}/llms.txt`, undefined)).toBe(`/v1/workspaces/${ID}/llms.txt`)
    expect(apiPathFor(`/workspaces/${ID}/llms-full.txt`, undefined)).toBe(`/v1/workspaces/${ID}/llms-full.txt`)
    expect(apiPathFor(`/projects/${P}/llms.txt`, undefined)).toBe(`/v1/projects/${P}/llms.txt`)
    expect(apiPathFor(`/projects/${P}/llms-full.txt`, undefined)).toBe(`/v1/projects/${P}/llms-full.txt`)
  })

  it('leaves everything else to the SSR app', () => {
    for (const path of [
      `/documents/${ID}/edit`,
      '/documents/not-a-uuid.md',
      `/documents/${ID}.md/x`,
      `/documents/${ID}.markdown`,
      '/documents',
      '/llms-full.txt',
      `/projects/${P}`,
      `/projects/${P}/llms.md`,
      `/teams/${P}/llms.txt`,
      `/x/llms.txt`,
    ]) {
      expect(apiPathFor(path, 'text/markdown')).toBeNull()
    }
  })
})

describe('forwardedAuthorization', () => {
  it('prefers an explicit header over the session cookie', () => {
    expect(forwardedAuthorization('Bearer kn_a', 'ks_b')).toBe('Bearer kn_a')
  })
  it('falls back to the kn_token cookie', () => {
    expect(forwardedAuthorization(undefined, 'ks_b')).toBe('Bearer ks_b')
    expect(forwardedAuthorization('  ', 'ks_b')).toBe('Bearer ks_b')
  })
  it('is null with no credential', () => {
    expect(forwardedAuthorization(undefined, null)).toBeNull()
  })
})

// --- the middleware over a real Express server and a fake upstream ---------

function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

let server
afterEach(() => server?.close())

/** Start the app on an ephemeral port; `upstream` plays the API. */
async function start(upstream) {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method })
    return upstream(url, init)
  }
  const app = express()
  app.use(aiReadableMiddleware({ apiBase: 'http://api.test/', readCookie, fetch: fakeFetch }))
  app.use((_req, res) => res.status(200).set({ 'Content-Type': 'text/html' }).send('<html>ssr</html>'))
  server = app.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, calls }
}

const md = (body, headers = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8', etag: '"abc"', vary: 'Accept', ...headers },
  })

describe('aiReadableMiddleware', () => {
  it('passes .md through with the bearer, query string and API headers', async () => {
    const { base, calls } = await start(() => md('# Title\n\nbody\n'))
    const res = await fetch(`${base}/documents/${ID}.md?frontmatter=1`, {
      headers: { authorization: 'Bearer kn_key', 'if-none-match': '"old"' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('# Title\n\nbody\n')
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('etag')).toBe('"abc"')
    expect(res.headers.get('vary')).toMatch(/Accept/)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`http://api.test/v1/documents/${ID}/markdown?frontmatter=1`)
    expect(calls[0].headers.authorization).toBe('Bearer kn_key')
    expect(calls[0].headers['if-none-match']).toBe('"old"')
  })

  it('authenticates a logged-in tab from the kn_token cookie', async () => {
    const { base, calls } = await start(() => md('# T\n'))
    const res = await fetch(`${base}/documents/${ID}.md`, { headers: { cookie: 'kn_lang=ru; kn_token=ks_session' } })
    expect(res.status).toBe(200)
    expect(calls[0].headers.authorization).toBe('Bearer ks_session')
  })

  it('answers 401 in plain text with the API-key hint, without calling the API', async () => {
    const { base, calls } = await start(() => md('never'))
    const res = await fetch(`${base}/documents/${ID}.md`)
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toMatch(/\/settings\/connect/)
    expect(calls).toHaveLength(0)
  })

  it('turns an upstream 401 into the same hint, and other errors into one text line', async () => {
    let status = 401
    const { base } = await start(
      () => new Response(JSON.stringify({ statusCode: status, message: 'Forbidden workspace' }), { status }),
    )
    let res = await fetch(`${base}/documents/${ID}.md`, { headers: { authorization: 'Bearer bad' } })
    expect(res.status).toBe(401)
    expect(await res.text()).toMatch(/\/settings\/connect/)

    status = 403
    res = await fetch(`${base}/documents/${ID}.md`, { headers: { authorization: 'Bearer kn_key' } })
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('403 Forbidden workspace\n')
  })

  it('relays 304 with no body', async () => {
    const { base } = await start(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }))
    const res = await fetch(`${base}/documents/${ID}.md`, {
      headers: { authorization: 'Bearer kn_key', 'if-none-match': '"abc"' },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"abc"')
  })

  it('negotiates /documents/:id on Accept, and the SSR page varies on Accept', async () => {
    const { base, calls } = await start(() => md('# Negotiated\n'))
    let res = await fetch(`${base}/documents/${ID}`, {
      headers: { accept: 'text/markdown', authorization: 'Bearer kn_key' },
    })
    expect(await res.text()).toBe('# Negotiated\n')

    res = await fetch(`${base}/documents/${ID}`, {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', authorization: 'Bearer kn_key' },
    })
    expect(await res.text()).toBe('<html>ssr</html>')
    expect(res.headers.get('vary')).toMatch(/Accept/)
    expect(calls).toHaveLength(1)
  })

  it('streams llms-full.txt', async () => {
    const chunks = ['# Workspace\n', '\n## Page one\n', '\nbody\n']
    const stream = new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s))
        c.close()
      },
    })
    const { base, calls } = await start(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    )
    const res = await fetch(`${base}/workspaces/${ID}/llms-full.txt`, { headers: { authorization: 'Bearer kn_key' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(chunks.join(''))
    expect(calls[0].url).toBe(`http://api.test/v1/workspaces/${ID}/llms-full.txt`)
  })

  it('maps the root /llms.txt hub', async () => {
    const { base, calls } = await start(() => md('# Hub\n', { 'content-type': 'text/plain; charset=utf-8' }))
    const res = await fetch(`${base}/llms.txt`, { headers: { authorization: 'Bearer kn_key' } })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('http://api.test/v1/llms.txt')
  })

  it('answers 502 in plain text when the API is down', async () => {
    const { base } = await start(() => {
      throw new Error('ECONNREFUSED')
    })
    const res = await fetch(`${base}/documents/${ID}.md`, { headers: { authorization: 'Bearer kn_key' } })
    expect(res.status).toBe(502)
    expect(await res.text()).toMatch(/unreachable/)
  })

  it('ignores non-GET and unrelated paths', async () => {
    const { base, calls } = await start(() => md('never'))
    expect(await (await fetch(`${base}/documents/${ID}.md`, { method: 'POST' })).text()).toBe('<html>ssr</html>')
    expect(await (await fetch(`${base}/settings`)).text()).toBe('<html>ssr</html>')
    expect(calls).toHaveLength(0)
  })
})
