// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { proxyImages } from './proxy-images'

// #1133: page images load from the app's own origin, so the member CSP can hold img-src there.
describe('proxyImages', () => {
  const srcOf = (html: string) => new DOMParser().parseFromString(proxyImages(html), 'text/html').querySelector('img')!.getAttribute('src')

  it('sends a remote image through the image proxy', () => {
    expect(srcOf('<img src="https://img.example/a.png?x=1&y=2">')).toBe(`/api/v1/image-proxy?url=${encodeURIComponent('https://img.example/a.png?x=1&y=2')}`)
    expect(srcOf('<img src="//img.example/a.png">')).toBe(`/api/v1/image-proxy?url=${encodeURIComponent('https://img.example/a.png')}`)
  })

  it('prefixes an attachment and leaves data: alone', () => {
    expect(srcOf('<img src="/v1/attachments/1/file">')).toBe('/api/v1/attachments/1/file')
    expect(srcOf('<img src="data:image/png;base64,AAAA">')).toBe('data:image/png;base64,AAAA')
  })

  it('drops srcset, whose candidates would load from the other host', () => {
    expect(proxyImages('<picture><source srcset="https://a.example/1.webp"><img src="https://a.example/1.png" srcset="https://a.example/2.png 2x"></picture>')).not.toContain('srcset')
  })
})
