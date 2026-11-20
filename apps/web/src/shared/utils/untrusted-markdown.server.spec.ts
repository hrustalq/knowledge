import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { markdownToHtml } from '@/core/markdown/render'
import { sanitizeUntrusted } from './untrusted-markdown'

// #1331: the server sanitizes the assistant's opening conversation in a jsdom
// window. Node environment on purpose: no global `document`, as on the server.
describe('sanitizeUntrusted in a document of its own', () => {
  const { document } = new JSDOM('').window

  it('strips what the browser would, without reaching for a global document', () => {
    const html = sanitizeUntrusted(markdownToHtml('Hi <script>alert(1)</script> ![x](https://evil.example/p.png)'), document)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://evil.example/p.png"')
  })
})
