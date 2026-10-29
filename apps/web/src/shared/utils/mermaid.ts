import type { Mermaid, MermaidConfig } from 'mermaid'

/**
 * The one Mermaid config every render site uses (#438), export included —
 * export-render.ts serializes it into its inline script.
 *
 * - `htmlLabels: false`: Mermaid 11 otherwise draws labels as HTML inside
 *   `<foreignObject>`, which the SVG sanitize profile strips whole, leaving
 *   boxes with no text. The flowchart key is deprecated, but 11.17 still reads
 *   it alone for swimlane cluster titles, so both are set.
 * - `mirrorActors: false`: the second participant row under the lifelines reads
 *   as duplicate entities. An author can turn it back on per diagram with
 *   `%%{init: {"sequence": {"mirrorActors": true}}}%%`.
 */
export function mermaidConfig(isDark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
    fontFamily: 'inherit',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    sequence: { mirrorActors: false },
  }
}

let renders = 0

/**
 * Parse, then render with a page-unique id. Returns the SVG (still to be
 * sanitized) and the diagram type the parser detected.
 *
 * - The id: mermaid scopes styles and markers by it, so two diagrams sharing
 *   one draw into each other. A per-component counter plus `Date.now()`
 *   collided whenever two blocks mounted in the same millisecond, leaving one
 *   empty and the other holding both (#476).
 * - The parse: a failed `render` leaves mermaid's "Syntax error" bomb appended
 *   to `<body>`; a failed `parse` throws the same error and leaves nothing.
 */
export async function mermaidSvg(mermaid: Mermaid, code: string): Promise<{ svg: string; type: string }> {
  const parsed = await mermaid.parse(code)
  const { svg } = await mermaid.render(`kn-mmd-${++renders}`, code)
  return { svg, type: parsed ? parsed.diagramType.replace(/-v\d+$/, '') : '' }
}

export interface MermaidProblem {
  /** 1-based line in the author's source, when the parser named one. */
  line: number | null
  /** What the parser expected, without its ASCII caret: the line is highlighted instead. */
  message: string
}

/**
 * A mermaid parse error in the editor's terms (#476). Every parser, jison or
 * langium, says "line N"; it counts from the diagram body, after YAML
 * frontmatter is stripped, so that is added back.
 */
export function mermaidProblem(error: unknown, source: string): MermaidProblem {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const at = Number(/line (\d+)/i.exec(text)?.[1])
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)?.[0]
  const offset = front ? front.split('\n').length - 1 : 0
  const line = at > 0 ? Math.min(at + offset, source.split('\n').length) : null
  const detail = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const expecting = detail.find((l) => l.includes('Expecting'))
  return { line, message: expecting ? expecting.slice(expecting.indexOf('Expecting')) : (detail[0] ?? '') }
}
