/**
 * Diagrams a reader can open full-screen (#476): rendered mermaid blocks and
 * whiteboard drawings. The counterpart of lib/image-gallery, and a separate
 * sequence — ←/→ in one never lands in the other.
 *
 * A surface marks a diagram with `DIAGRAM_ATTR` once its SVG is in the DOM, so
 * a mermaid fence that failed to parse (`.kn-mermaid-broken`, its source on
 * show) is never marked and opens nothing. The lightbox shows a copy of the SVG
 * the page drew, so it matches the page and costs no request.
 */
export const DIAGRAM_ATTR = 'data-kn-diagram'

type Translate = (key: string, named?: Record<string, unknown>) => string

/** The attributes that make a rendered diagram a button that opens the lightbox. */
export function diagramAttrs(t: Translate): Record<string, string> {
  return { [DIAGRAM_ATTR]: '', tabindex: '0', role: 'button', 'aria-label': t('diagramViewer.open') }
}

/** Mark every rendered diagram under `root` (MarkdownView's and the public reader's markup). */
export function markDiagrams(root: Element, t: Translate) {
  for (const el of root.querySelectorAll('.kn-mermaid-figure, .kn-drawing-canvas')) {
    if (!el.querySelector('svg')) continue
    for (const [name, value] of Object.entries(diagramAttrs(t))) el.setAttribute(name, value)
  }
}

/** The marked diagram an event landed on, if any. A link inside one still follows the link. */
export function diagramAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || target.closest('a')) return null
  return target.closest<HTMLElement>(`[${DIAGRAM_ATTR}]`)
}

/** Every marked diagram under `root`, in document order. */
export function diagramsIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${DIAGRAM_ATTR}]`)]
}

export interface DiagramCopy {
  /** The page's own SVG element, to tell a re-draw from the copy already shown. */
  source: SVGSVGElement
  svg: SVGSVGElement
  /** Its size at 1:1, from the viewBox. */
  w: number
  h: number
}

/**
 * A copy of a diagram's SVG, sized by whoever shows it. Mermaid caps its own
 * width inline and drawings fill their column; both are undone here. Ids are
 * kept: a duplicate id resolves to the page's identical marker or style.
 */
export function copyDiagram(host: Element): DiagramCopy | null {
  const source = host.querySelector('svg')
  if (!source) return null
  const [, , w = 0, h = 0] = (source.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  if (!(w > 0 && h > 0)) return null
  const svg = source.cloneNode(true) as SVGSVGElement
  svg.style.maxWidth = 'none'
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  return { source, svg, w, h }
}
