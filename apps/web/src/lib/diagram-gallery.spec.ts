// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { copyDiagram, diagramAt, diagramsIn, markDiagrams } from './diagram-gallery'

describe('diagram gallery', () => {
  it('marks rendered diagrams only and copies their SVG at viewBox size', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="kn-mermaid-figure"><svg viewBox="0 0 800 200" style="max-width: 800px"><a href="#x"><text>link</text></a><rect/></svg></div>
      <pre class="kn-mermaid-broken" data-kn-mermaid>graph TD; A--</pre>
      <div class="kn-drawing-canvas"><svg viewBox="0 0 640 480" width="100%"></svg></div>`
    markDiagrams(root, (key) => key)

    const [mermaid, drawing] = diagramsIn(root)
    expect(diagramsIn(root)).toHaveLength(2)
    expect(mermaid!.getAttribute('aria-label')).toBe('diagramViewer.open')
    expect(mermaid!.tabIndex).toBe(0)

    expect(diagramAt(mermaid!.querySelector('rect'))).toBe(mermaid)
    expect(diagramAt(mermaid!.querySelector('text'))).toBeNull()
    expect(diagramAt(root.querySelector('pre'))).toBeNull()

    const copy = copyDiagram(mermaid!)!
    expect([copy.w, copy.h]).toEqual([800, 200])
    expect(copy.svg).not.toBe(copy.source)
    expect(copy.svg.style.maxWidth).toBe('none')
    expect(copyDiagram(drawing!)!.svg.getAttribute('height')).toBe('100%')
  })
})
