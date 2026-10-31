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

  it('points attachments at the browser-facing API base', () => {
    expect(render('![a](/v1/attachments/1/file)')).toContain('src="/api/v1/attachments/1/file"')
  })
})
