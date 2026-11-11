// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { galleryFrom, markZoomable, zoomableAt } from './image-gallery'

describe('image gallery', () => {
  it('marks unlinked images and collects them in document order', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <p><img src="/a.png" alt="first"></p>
      <a href="https://x.test"><img src="/linked.png" alt="badge"></a>
      <p><img src="/b.png" title="second"></p>`
    markZoomable(root, (key, named) => `${key} ${named?.name ?? ''}`.trim())

    const [first, linked, second] = root.querySelectorAll('img')
    expect(zoomableAt(linked!)).toBeNull()
    expect(zoomableAt(second!)).toBe(second)
    expect(second!.getAttribute('aria-label')).toBe('imageViewer.openNamed second')
    expect(second!.tabIndex).toBe(0)

    const { images, index } = galleryFrom(root, second!)
    expect(images.map((i) => i.alt)).toEqual(['first', 'second'])
    expect(index).toBe(1)
    expect(zoomableAt(first!)).toBe(first)
  })
})
