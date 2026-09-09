import type { WorkflowGraph, WorkflowStep } from '@knowledge/contracts'

/**
 * Where the steps of a workflow sit.
 *
 * A workflow is a DAG with a direction — a run enters at one step and moves
 * forward — so this is a layered (Sugiyama) layout, not the force simulation the
 * knowledge graph runs. That difference is the whole point: a force layout
 * answers "what is near what", which is the right question about a relation
 * graph and the wrong one about a chain. Here the reader needs to see what
 * happens *first*, and a node whose position is a settling artefact cannot tell
 * them.
 *
 * One module, two renderers. `WorkflowGraphEditor` hands these coordinates to
 * Vue Flow when you press Tidy up, and `WorkflowMap` draws them on canvas
 * wherever the chain is being read rather than edited. Positions can therefore
 * never disagree between the two views of the same definition, and auto-layout
 * came free with the preview — which is the argument that let the editable
 * canvas stay in Vue Flow while everything read-only moved to a drawn one.
 *
 * Left to right, because that is the direction a pipeline is read in and the
 * direction a fan-out opens: one step on the left, its items stacked on the
 * right. Top-to-bottom would put the fan across the reading axis and force a
 * horizontal scroll at exactly the moment there is most to see.
 */

export interface LayoutOptions {
  nodeWidth: number
  nodeHeight: number
  /** Between layers, along the flow. */
  rankGap: number
  /** Between siblings within a layer. */
  nodeGap: number
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 216,
  nodeHeight: 72,
  rankGap: 96,
  nodeGap: 24,
}

export interface LayoutBox {
  id: string
  /** Top-left in world units — the same corner Vue Flow's `position` names. */
  x: number
  y: number
  rank: number
}

export interface WorkflowLayout {
  boxes: LayoutBox[]
  by: Record<string, LayoutBox>
  width: number
  height: number
  nodeWidth: number
  nodeHeight: number
  /** How many layers deep the chain runs. */
  ranks: number
}

/** Straightening passes. Four is where the arrangement stops changing. */
const SWEEPS = 4

/**
 * Longest-path layering.
 *
 * A step sits one layer after the last step that can reach it, so an edge never
 * points backwards and the reader can trust left-of to mean before.
 *
 * Cycles are handled rather than assumed away. `validateGraph` rejects them and
 * the editor says so live, but a graph arrives here mid-edit — the instant
 * between drawing the closing edge and the canvas reporting it — and a layout
 * that threw then would blank the canvas at exactly the moment the drawing has
 * to be visible to be understood. Whatever the topological pass could not
 * place is appended after everything it depends on.
 */
function rankOf(steps: WorkflowStep[]): Map<string, number> {
  const ids = new Set(steps.map((s) => s.id))
  const incoming = new Map<string, number>()
  for (const step of steps) incoming.set(step.id, 0)
  for (const step of steps) {
    for (const next of step.next) {
      if (ids.has(next) && next !== step.id) incoming.set(next, (incoming.get(next) ?? 0) + 1)
    }
  }

  const rank = new Map<string, number>()
  // Seeded in declaration order, so two graphs with the same shape lay out the
  // same way — a layout that depends on Map iteration luck is one that shifts
  // under the reader for no reason they can see.
  const queue = steps.filter((s) => (incoming.get(s.id) ?? 0) === 0).map((s) => s.id)
  for (const id of queue) rank.set(id, 0)

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    const step = steps.find((s) => s.id === id)
    if (!step) continue
    for (const next of step.next) {
      if (!ids.has(next) || next === id) continue
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1))
      const left = (incoming.get(next) ?? 0) - 1
      incoming.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  // Anything left is inside a cycle: park it after its deepest ranked feeder.
  for (const step of steps) {
    if (rank.has(step.id)) continue
    let deepest = 0
    for (const other of steps) {
      if (other.next.includes(step.id) && rank.has(other.id)) {
        deepest = Math.max(deepest, (rank.get(other.id) ?? 0) + 1)
      }
    }
    rank.set(step.id, deepest)
  }
  return rank
}

/** Mean of a list, or null when there is nothing to average. */
function mean(values: number[]): number | null {
  if (!values.length) return null
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * Place one layer as close to where its neighbours want it as the order allows.
 *
 * Desired positions are met exactly wherever they can be, then a single forward
 * pass opens any overlap, and the layer is translated back so its centre of
 * mass lands where the neighbours pulled it. Pushing down and then pulling up
 * instead — the obvious symmetric fix — can undo the first pass's work and
 * leaves layers that visibly jitter between renders of the same graph.
 */
function pack(desires: number[], step: number): number[] {
  const out = desires.slice()
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i]!, out[i - 1]! + step)
  const wanted = mean(desires)
  const got = mean(out)
  if (wanted === null || got === null) return out
  const shift = wanted - got
  return out.map((y) => y + shift)
}

export function layoutWorkflow(graph: WorkflowGraph, options?: Partial<LayoutOptions>): WorkflowLayout {
  const opts = { ...DEFAULT_LAYOUT, ...options }
  const steps = graph.steps ?? []
  if (!steps.length) {
    return { boxes: [], by: {}, width: 0, height: 0, ranks: 0, nodeWidth: opts.nodeWidth, nodeHeight: opts.nodeHeight }
  }

  const rank = rankOf(steps)
  const ranks = Math.max(...steps.map((s) => rank.get(s.id) ?? 0)) + 1

  /** Step ids per layer, in the order they will be stacked. */
  const layers: string[][] = Array.from({ length: ranks }, () => [])
  for (const step of steps) layers[rank.get(step.id) ?? 0]!.push(step.id)

  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const ids = new Set(steps.map((s) => s.id))
  for (const step of steps) {
    for (const next of step.next) {
      if (!ids.has(next) || next === step.id) continue
      children.set(step.id, [...(children.get(step.id) ?? []), next])
      parents.set(next, [...(parents.get(next) ?? []), step.id])
    }
  }

  const index = new Map<string, number>()
  const reindex = () => {
    for (const layer of layers) layer.forEach((id, i) => index.set(id, i))
  }
  reindex()

  /**
   * Crossing reduction: each node moves to the average position of the
   * neighbours it is tied to, sweeping down the chain and back. Nodes with no
   * neighbour on the side being read keep their place rather than drifting to
   * the top, which is what keeps a disconnected step where its author put it.
   */
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0
    const order = forward ? [...layers.keys()].slice(1) : [...layers.keys()].slice(0, -1).reverse()
    for (const r of order) {
      const relatives = forward ? parents : children
      const layer = layers[r]!
      const keys = new Map<string, number>()
      layer.forEach((id, i) => {
        const positions = (relatives.get(id) ?? []).map((other) => index.get(other) ?? 0)
        keys.set(id, mean(positions) ?? i)
      })
      // Stable on ties: an untied node must not swap with its neighbour every
      // sweep, or the layout never converges.
      layer.sort((a, b) => (keys.get(a) ?? 0) - (keys.get(b) ?? 0) || (index.get(a) ?? 0) - (index.get(b) ?? 0))
      reindex()
    }
  }

  // ---- vertical placement
  const step = opts.nodeHeight + opts.nodeGap
  const y = new Map<string, number>()
  for (const layer of layers) layer.forEach((id, i) => y.set(id, i * step))

  const centre = (id: string) => (y.get(id) ?? 0) + opts.nodeHeight / 2
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0
    const order = forward ? [...layers.keys()] : [...layers.keys()].reverse()
    for (const r of order) {
      const relatives = forward ? parents : children
      const layer = layers[r]!
      const desires = layer.map((id) => {
        const anchored = mean((relatives.get(id) ?? []).map(centre))
        return anchored === null ? (y.get(id) ?? 0) : anchored - opts.nodeHeight / 2
      })
      pack(desires, step).forEach((value, i) => y.set(layer[i]!, value))
    }
  }

  const boxes: LayoutBox[] = steps.map((s) => ({
    id: s.id,
    rank: rank.get(s.id) ?? 0,
    x: (rank.get(s.id) ?? 0) * (opts.nodeWidth + opts.rankGap),
    y: y.get(s.id) ?? 0,
  }))

  // Normalize to a non-negative origin so a consumer can treat the result as a
  // plain box of `width × height` without carrying an offset alongside it.
  const minY = Math.min(...boxes.map((b) => b.y))
  for (const box of boxes) box.y = Math.round(box.y - minY)

  const by: Record<string, LayoutBox> = {}
  for (const box of boxes) by[box.id] = box

  return {
    boxes,
    by,
    width: (ranks - 1) * (opts.nodeWidth + opts.rankGap) + opts.nodeWidth,
    height: Math.max(...boxes.map((b) => b.y)) + opts.nodeHeight,
    ranks,
    nodeWidth: opts.nodeWidth,
    nodeHeight: opts.nodeHeight,
  }
}

/** Coordinates in the shape `WorkflowGraph.layout` stores them. */
export function layoutPositions(
  graph: WorkflowGraph,
  options?: Partial<LayoutOptions>,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  for (const box of layoutWorkflow(graph, options).boxes) out[box.id] = { x: box.x, y: box.y }
  return out
}

/**
 * The curve an edge takes between two boxes, as canvas control points.
 *
 * The handle offset grows with the horizontal distance, so an edge that skips
 * a layer bows further out and reads as passing *over* the steps between rather
 * than stopping at them. A fixed offset makes long edges cut a straight line
 * through intermediate nodes, which is the single thing that makes a layered
 * graph look wrong.
 */
export function edgeCurve(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodeWidth: number,
  nodeHeight: number,
): { x1: number; y1: number; cx1: number; cy1: number; cx2: number; cy2: number; x2: number; y2: number } {
  const x1 = from.x + nodeWidth
  const y1 = from.y + nodeHeight / 2
  const x2 = to.x
  const y2 = to.y + nodeHeight / 2
  const reach = Math.max(Math.abs(x2 - x1) * 0.45, 28)
  return { x1, y1, cx1: x1 + reach, cy1: y1, cx2: x2 - reach, cy2: y2, x2, y2 }
}
