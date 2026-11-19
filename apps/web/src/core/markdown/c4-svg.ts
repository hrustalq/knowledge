/**
 * A C4 view drawn where its author put each element (#1244): the reader's
 * drawing of a view that has a `// @layout` line, the builder's canvas, and
 * export's static picture of such a view. Pure, a string of SVG, so it runs on
 * the server too — the counterpart of ./drawing's renderSceneToSvg. A view
 * with no layout is still mermaid's (structurizr.ts); `autoLayout` is only
 * where the builder starts an author off.
 *
 * Every box is the same size, as in Structurizr: no text measuring, so the
 * server and the browser draw the same picture. Page text is escaped; the
 * caller sanitizes the result as SVG anyway, as it does mermaid's.
 */
import { escapeHtml } from './nodes'
import {
  C4_PALETTE,
  KIND_LABEL,
  isDatabase,
  kindLine,
  styleOf,
  viewElements,
  viewRelationships,
  wrap,
  type C4Element,
  type C4Model,
  type C4Point,
  type C4View,
} from './structurizr'

export const NODE_W = 220
export const NODE_H = 130
const GAP_X = 90
const GAP_Y = 120

export type C4Positions = Map<C4Element, C4Point>

/**
 * A first arrangement: each element one row below everything that points at
 * it (longest path, so a cycle cannot loop), rows centred. `LR` / `RL` turn
 * the rows into columns.
 */
export function autoLayout(model: C4Model, view: C4View, nodes = viewElements(model, view).nodes): C4Positions {
  const edges = viewRelationships(model, nodes)
  const rank = new Map(nodes.map((n) => [n, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const { from, to } of edges) {
      const r = Math.min(rank.get(from)! + 1, nodes.length)
      if (r > rank.get(to)!) {
        rank.set(to, r)
        moved = true
      }
    }
    if (!moved) break
  }
  const rows: C4Element[][] = []
  for (const n of nodes) (rows[rank.get(n)!] ??= []).push(n)
  const across = view.direction === 'LR' || view.direction === 'RL'
  const out: C4Positions = new Map()
  rows.filter(Boolean).forEach((row, r) => {
    row.forEach((n, i) => {
      const along = (i - (row.length - 1) / 2) * (across ? NODE_H + GAP_Y : NODE_W + GAP_X)
      const step = r * (across ? NODE_W + GAP_X : NODE_H + GAP_Y)
      out.set(n, across ? { x: step, y: Math.round(along) } : { x: Math.round(along), y: step })
    })
  })
  return out
}

/**
 * Where each shown element sits: the view's layout, and for anything it does
 * not place (added in the source since), a row under the lowest one placed.
 */
export function positionsOf(model: C4Model, view: C4View, nodes = viewElements(model, view).nodes): C4Positions {
  if (!view.layout) return autoLayout(model, view, nodes)
  const out: C4Positions = new Map()
  const missing: C4Element[] = []
  for (const n of nodes) {
    const at = view.layout[n.id]
    if (at) out.set(n, at)
    else missing.push(n)
  }
  const bottom = Math.max(0, ...[...out.values()].map((p) => p.y + NODE_H + GAP_Y))
  missing.forEach((n, i) => out.set(n, { x: i * (NODE_W + GAP_X), y: out.size ? bottom : 0 }))
  return out
}

export interface C4SvgOptions {
  /** false: no viewBox, drawn at 1:1 from the origin and overflowing — the builder pans and zooms it. */
  frame?: boolean
  /** The builder's connect handles, one on each element. */
  handles?: boolean
  selectedNode?: C4Element | null
  selectedRelationship?: number | null
}

/**
 * The view as SVG. Elements are `g[data-c4-node="<i>"]`, i indexing `nodes`;
 * relationships are `g[data-c4-rel="<i>"]`, i indexing the model's.
 */
export function renderC4Svg(
  model: C4Model,
  view: C4View,
  positions: C4Positions,
  options: C4SvgOptions = {},
): { svg: string; nodes: C4Element[] } {
  const { nodes, boundary } = viewElements(model, view)
  const at = (n: C4Element) => positions.get(n) ?? { x: 0, y: 0 }
  const parts: string[] = []
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    box.x0 = Math.min(box.x0, x0)
    box.y0 = Math.min(box.y0, y0)
    box.x1 = Math.max(box.x1, x1)
    box.y1 = Math.max(box.y1, y1)
  }

  // The boundary: the view's subject, drawn around what is inside it.
  const inner = boundary ? nodes.filter((n) => n.parent === boundary) : []
  if (boundary && inner.length) {
    const xs = inner.map((n) => at(n).x)
    const ys = inner.map((n) => at(n).y)
    const x = Math.min(...xs) - 28
    const y = Math.min(...ys) - 48
    const w = Math.max(...xs) + NODE_W + 28 - x
    const h = Math.max(...ys) + NODE_H + 28 - y
    grow(x, y, x + w, y + h)
    parts.push(
      `<g class="kn-c4-boundary"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="#8a8a8a" stroke-dasharray="6 4"/>` +
        `<text x="${x + 14}" y="${y + 26}" font-size="13" font-weight="600" fill="currentColor">${escapeHtml(`${boundary.name} [${KIND_LABEL[boundary.kind]}]`)}</text></g>`,
    )
  }

  // Relationships under the boxes, so an arrow never covers a label.
  const edges = viewRelationships(model, nodes)
  const pairs = new Set(edges.map((e) => `${nodes.indexOf(e.from)}>${nodes.indexOf(e.to)}`))
  for (const { from, to, rel, index } of edges) {
    const a = center(at(from))
    const b = center(at(to))
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    // Two arrows between the same pair, one each way: pulled apart so both read.
    const shift = pairs.has(`${nodes.indexOf(to)}>${nodes.indexOf(from)}`) ? 10 : 0
    const ox = (-dy / len) * shift
    const oy = (dx / len) * shift
    const t = clip(dx, dy)
    const x1 = a.x + dx * t + ox
    const y1 = a.y + dy * t + oy
    const x2 = b.x - dx * t + ox
    const y2 = b.y - dy * t + oy
    const d = `M${r(x1)} ${r(y1)} L${r(x2)} ${r(y2)}`
    const lines = [...wrap(rel.description, 26), ...(rel.technology ? [`[${rel.technology}]`] : [])]
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const lw = Math.max(0, ...lines.map((l) => l.length)) * 6.6 + 12
    const lh = lines.length * 15 + 6
    const label = lines.length
      ? `<rect x="${r(mx - lw / 2)}" y="${r(my - lh / 2)}" width="${r(lw)}" height="${lh}" rx="4" style="fill: var(--background, #ffffff)"/>` +
        `<text x="${r(mx)}" y="${r(my - lh / 2 + 15)}" font-size="12" text-anchor="middle" fill="currentColor">${tspans(lines, mx, 15)}</text>`
      : ''
    grow(Math.min(x1, x2, mx - lw / 2), Math.min(y1, y2, my - lh / 2), Math.max(x1, x2, mx + lw / 2), Math.max(y1, y2, my + lh / 2))
    const selected = options.selectedRelationship === index ? ' data-selected=""' : ''
    parts.push(
      `<g class="kn-c4-rel" data-c4-rel="${index}"${selected}>` +
        `<path d="${d}" fill="none" stroke="transparent" stroke-width="14"/>` +
        `<path class="kn-c4-line" d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#kn-c4-arrow)"/>${label}</g>`,
    )
  }

  nodes.forEach((n, i) => {
    const { x, y } = at(n)
    grow(x, y, x + NODE_W, y + NODE_H)
    const c = C4_PALETTE[styleOf(n, view)]
    const shape =
      n.kind === 'person'
        ? `<rect width="${NODE_W}" height="${NODE_H}" rx="44" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`
        : isDatabase(n)
          ? `<path d="M0 14 A${NODE_W / 2} 14 0 0 1 ${NODE_W} 14 V${NODE_H - 14} A${NODE_W / 2} 14 0 0 1 0 ${NODE_H - 14} Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>` +
            `<path d="M0 14 A${NODE_W / 2} 14 0 0 0 ${NODE_W} 14" fill="none" stroke="${c.stroke}" stroke-width="2"/>`
          : `<rect width="${NODE_W}" height="${NODE_H}" rx="8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`
    const name = wrap(n.name, 22).slice(0, 2)
    const desc = wrap(n.description, 30)
    const shownDesc = desc.length > 3 ? [...desc.slice(0, 2), `${desc[2]}…`] : desc
    const height = name.length * 18 + 16 + shownDesc.length * 15
    const top = (NODE_H - height) / 2 + 14
    const text =
      `<text x="${NODE_W / 2}" y="${r(top)}" text-anchor="middle" fill="${c.text}">` +
      name.map((l, k) => `<tspan x="${NODE_W / 2}" dy="${k ? 18 : 0}" font-size="15" font-weight="600">${escapeHtml(l)}</tspan>`).join('') +
      `<tspan x="${NODE_W / 2}" dy="17" font-size="11" opacity="0.85">${escapeHtml(kindLine(n))}</tspan>` +
      shownDesc.map((l, k) => `<tspan x="${NODE_W / 2}" dy="${k ? 15 : 18}" font-size="12">${escapeHtml(l)}</tspan>`).join('') +
      `</text>`
    const handle = options.handles
      ? `<circle class="kn-c4-handle" data-c4-handle="${i}" cx="${NODE_W}" cy="${NODE_H / 2}" r="7"/>`
      : ''
    const selected = options.selectedNode === n ? ' data-selected=""' : ''
    parts.push(`<g class="kn-c4-node" data-c4-node="${i}" transform="translate(${r(x)} ${r(y)})"${selected}>${shape}${text}${handle}</g>`)
  })

  const defs =
    '<defs><marker id="kn-c4-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
    '<path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>'
  if (!Number.isFinite(box.x0)) grow(0, 0, NODE_W, NODE_H)
  const m = 24
  const vb = [box.x0 - m, box.y0 - m, box.x1 - box.x0 + 2 * m, box.y1 - box.y0 + 2 * m].map(r)
  const open =
    options.frame === false
      ? '<svg xmlns="http://www.w3.org/2000/svg" class="kn-c4-svg" width="1" height="1" overflow="visible" style="overflow: visible; font-family: inherit">'
      : `<svg xmlns="http://www.w3.org/2000/svg" class="kn-c4-svg" viewBox="${vb.join(' ')}" width="${vb[2]}" height="${vb[3]}" style="max-width: 100%; height: auto; font-family: inherit">`
  return { svg: `${open}${defs}${parts.join('')}</svg>`, nodes }
}

const center = (p: C4Point) => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 })
const r = (n: number) => Math.round(n * 10) / 10

/** How far along (dx, dy) from a box's centre its edge is, as a fraction. */
function clip(dx: number, dy: number): number {
  const tx = dx ? NODE_W / 2 / Math.abs(dx) : Infinity
  const ty = dy ? NODE_H / 2 / Math.abs(dy) : Infinity
  return Math.min(tx, ty, 0.5)
}

function tspans(lines: string[], x: number, step: number): string {
  return lines.map((l, k) => `<tspan x="${r(x)}" dy="${k ? step : 0}">${escapeHtml(l)}</tspan>`).join('')
}
