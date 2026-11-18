import DOMPurify from 'dompurify'
import { positionsOf, renderC4Svg } from '@/core/markdown/c4-svg'
import { C4_NODE_PREFIX, viewToMermaid, type C4Element, type C4Model, type C4View } from '@/core/markdown/structurizr'
import { mermaidConfig, mermaidSvg } from '@/shared/utils/mermaid'
import { sanitizeUntrustedSvg } from '@/shared/utils/untrusted-markdown'

/**
 * A C4 view as sanitized SVG (#1244): where its author placed each element
 * when it has a `// @layout` line (core/markdown/c4-svg), else laid out by
 * mermaid. `nodes[i]` is the element a drawn node stands for — see `nodeAt`.
 */
export async function drawC4View(
  model: C4Model,
  view: C4View,
  { isDark, untrusted = false }: { isDark: boolean; untrusted?: boolean },
): Promise<{ html: string; nodes: C4Element[] }> {
  let svg: string
  let nodes: C4Element[]
  if (view.layout) {
    ;({ svg, nodes } = renderC4Svg(model, view, positionsOf(model, view)))
  } else {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize(mermaidConfig(isDark))
    const drawn = viewToMermaid(model, view)
    svg = (await mermaidSvg(mermaid, drawn.source)).svg
    nodes = drawn.nodes
  }
  return {
    html: untrusted ? sanitizeUntrustedSvg(svg) : DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }),
    nodes,
  }
}

/** Mermaid names a node's `<g>` `<render id>-flowchart-<node id>-<n>`. */
const MERMAID_NODE = new RegExp(`-flowchart-${C4_NODE_PREFIX}(\\d+)-\\d+$`)

/** The drawn node an event landed on, in either drawing, and its index into `nodes`. */
export function nodeAt(target: EventTarget | null): { g: SVGGElement; index: number } | null {
  const g = target instanceof Element ? target.closest<SVGGElement>('g[data-c4-node], g.node') : null
  if (!g) return null
  const index = g.dataset.c4Node !== undefined ? Number(g.dataset.c4Node) : Number(MERMAID_NODE.exec(g.id)?.[1] ?? NaN)
  return Number.isInteger(index) ? { g, index } : null
}
