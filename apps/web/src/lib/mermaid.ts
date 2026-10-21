import type { MermaidConfig } from 'mermaid'

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
