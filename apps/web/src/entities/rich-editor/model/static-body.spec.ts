import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { markdownToHtml } from '@/core/markdown/render'
import { staticBodyHtml } from './static-body'

/**
 * The read view's server-drawn body (#643) is set with v-html, so the schema
 * pass is the only thing between stored markdown and the reader's DOM.
 */
describe('staticBodyHtml', () => {
  const doc = new JSDOM('').window.document
  const render = (md: string) => staticBodyHtml(markdownToHtml(md), doc)

  it('draws the body the editor would', () => {
    const html = render('# Title\n\nSome **bold** text.\n\n- one\n- two')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<li>')
  })

  it('keeps nothing the schema does not know', () => {
    const html = render(
      'x <img src="x" onerror="alert(1)"> <script>alert(2)</script> [a](javascript:alert(3)) <iframe src="https://e.x"></iframe>',
    )
    expect(html).not.toMatch(/onerror|<script|javascript:|<iframe/i)
  })

  // GHSA-gvrv-7g78-f9p6: the custom blocks copy an href out of raw HTML, so
  // they must check it themselves — the Link mark's filter never sees it.
  const ATT = '/v1/documents/11111111-1111-4111-8111-111111111111/attachments/22222222-2222-4222-8222-222222222222/content'
  const file = (href: string) =>
    `<div data-kn-file="22222222-2222-4222-8222-222222222222" data-kn-name="a.pdf" data-kn-mime="application/pdf"><a href="${href}">a.pdf</a></div>`

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'https://evil.example/x.pdf', 'data:text/html,x'])(
    'an attachment block keeps no href that is not an attachment route (%s)',
    (href) => {
      const html = render(file(href))
      expect(html).toContain('data-kn-file')
      expect(html).not.toMatch(/javascript:|evil\.example|data:text/i)
    },
  )

  it('an attachment block keeps its attachment route', () => {
    expect(render(file(ATT))).toContain(`href="/api${ATT}"`)
  })

  it('an embed item keeps only an http(s) href', () => {
    const html = render(
      '<figure data-kn-embed="strip">\n<a href="javascript:alert(1)">x</a>\n<a href="https://example.com/a">y</a>\n</figure>',
    )
    expect(html).not.toMatch(/javascript:/i)
    expect(html).toContain('href="https://example.com/a"')
  })

  it('points attachments at the browser-facing API base', () => {
    expect(render('![a](/v1/attachments/1/file)')).toContain('src="/api/v1/attachments/1/file"')
  })
})
