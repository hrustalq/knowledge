<script setup lang="ts">
/**
 * The relation graph, drawn on a canvas over a live d3-force simulation.
 *
 * The predecessor asked Cytoscape for a one-shot `cose` layout and then drew an
 * arrowhead and a rotated, background-filled label on every edge. At four
 * relations that is a diagram; at a hundred the labels merge into a solid block
 * and the graph stops carrying any information at all. The rules here follow
 * from that failure:
 *
 * - **Edges are hairlines, unlabelled, un-arrowed.** An edge's job at this
 *   density is to say two things are connected. Its type is a fact about one
 *   edge, so it is read one edge at a time — on hover, in the node card.
 * - **Size is the hierarchy.** Radius comes from degree, so the hubs of a
 *   knowledge base are visible before a single word is read.
 * - **Labels are earned.** Below the zoom threshold only the loud nodes are
 *   named; everything gets named as you zoom in, and the focused neighborhood
 *   is always named whatever the zoom.
 * - **Hover is the query.** Lighting one neighborhood and dropping the rest to
 *   a whisper answers "what does this touch" without a click or a panel.
 *
 * The simulation is a real one — drag reheats it and the graph re-settles —
 * but the render loop parks itself the moment nothing is moving, because a page
 * people read for an hour must not hold a rAF loop open behind the text.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useResizeObserver } from '@vueuse/core'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force'
import { DEFAULT_OPTIONS, project, radiusOf, type GraphEdgeInput, type GraphNodeInput, type GraphOptions } from './graph-model'
import { entityColor, mix, readPalette, rgba, type GraphPalette } from './graph-theme'

const props = withDefaults(
  defineProps<{
    nodes: GraphNodeInput[]
    edges: GraphEdgeInput[]
    /** The page this graph is *about*, drawn lit and haloed. */
    rootId?: string | null
    options?: GraphOptions
    /** Substring match: matches stay lit, everything else recedes. */
    query?: string
    /** `compact` is the rail widget: smaller type, tighter forces, no hints. */
    density?: 'compact' | 'roomy'
    /** Screen px on the left the framing must keep clear (the control panel). */
    insetLeft?: number
  }>(),
  { rootId: null, query: '', density: 'roomy', insetLeft: 0, options: () => DEFAULT_OPTIONS },
)

const emit = defineEmits<{
  open: [id: string]
  select: [node: GraphNodeInput | null]
  stats: [value: { nodes: number; edges: number; orphans: number; counts: Record<string, number> }]
}>()

const { t } = useI18n()

type SimNode = GraphNodeInput & { x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null; r: number }
type SimEdge = { source: SimNode; target: SimNode; type: string; extractor: string; inferred: boolean }

const uid = `kn-graph-${Math.random().toString(36).slice(2, 8)}`

const hostEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const palette = shallowRef<GraphPalette | null>(null)

const sim = shallowRef<Simulation<SimNode, undefined> | null>(null)
let simNodes: SimNode[] = []
let simEdges: SimEdge[] = []
/** Positions survive a re-projection, so toggling a filter does not reshuffle. */
const remembered = new Map<string, { x: number; y: number }>()
const adjacency = new Map<string, Set<string>>()

const view = { k: 1, x: 0, y: 0 }
let width = 0
let height = 0
let dpr = 1

/**
 * The focused node is held as the node itself, not as an id resolved against
 * `simNodes` inside a computed. `simNodes` is a plain array the simulation
 * mutates sixty times a second — deliberately, since making 300 nodes reactive
 * would cost a dependency notification per node per tick — and a computed that
 * reads it has no dependency to invalidate on. The pick already has the object;
 * keeping it is both cheaper and the only version that is actually correct.
 */
const hovered = shallowRef<SimNode | null>(null)
/** A click parks the focus so the reader can leave the pointer and study it. */
const pinned = shallowRef<SimNode | null>(null)
const focusNode = computed(() => pinned.value ?? hovered.value)
const focusId = computed(() => focusNode.value?.id ?? null)
const hoverPoint = ref<{ x: number; y: number } | null>(null)

const reduced =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const compact = computed(() => props.density === 'compact')
/** Eased 0..1 toward "a neighborhood is lit", so dimming never snaps. */
let focusMix = 0
let raf = 0
let running = false
let lastFrame = 0

const projection = computed(() => project(props.nodes, props.edges, props.options))
const isEmpty = computed(() => projection.value.nodes.length === 0)

/* --------------------------------------------------------------- geometry */

const toScreenX = (x: number) => x * view.k + view.x
const toScreenY = (y: number) => y * view.k + view.y

/**
 * Frame the graph inside the room actually available. `insetLeft` is the
 * instrument panel: without it the layout centres under the panel and the
 * reader sees a graph that looks shoved to the right of its own canvas.
 */
function fit(paddingOverride?: number) {
  if (!simNodes.length || !width || !height) return
  // Proportional, floored and capped. A fixed 44px is right on a full-page
  // canvas and eats a third of a rail widget.
  const padding = paddingOverride ?? Math.max(14, Math.min(44, Math.min(width, height) * 0.09))
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of simNodes) {
    minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r)
    minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r)
  }
  const left = padding + props.insetLeft
  const availW = Math.max(width - left - padding, 80)
  const availH = Math.max(height - padding * 2, 80)
  const w = Math.max(maxX - minX, 1)
  const h = Math.max(maxY - minY, 1)
  view.k = Math.min(Math.min(availW / w, availH / h), 1.6)
  view.x = left + availW / 2 - ((minX + maxX) / 2) * view.k
  view.y = padding + availH / 2 - ((minY + maxY) / 2) * view.k
  // An explicit fit hands framing back to the graph, so automatic reframing
  // resumes from here.
  userFramed = false
  wake()
}

/**
 * Whether the reader has framed the view themselves. Once they have, the graph
 * stops reframing on its own — a canvas that re-centres because a rail widget
 * finished animating, or because the window changed by a pixel, throws away
 * the exact thing they were looking at.
 */
let userFramed = false

function zoomBy(factor: number, cx = width / 2, cy = height / 2) {
  userFramed = true
  const next = Math.min(Math.max(view.k * factor, 0.12), 4)
  const ratio = next / view.k
  view.x = cx - (cx - view.x) * ratio
  view.y = cy - (cy - view.y) * ratio
  view.k = next
  wake()
}

defineExpose({ fit, zoomBy, clearFocus: () => { pinned.value = null; wake() } })

/* ------------------------------------------------------------- simulation */

let fitted = false
let refitOnSettle = false
let lastStructure = ''

function build() {
  const { nodes, edges, counts, orphanCount } = projection.value
  emit('stats', { nodes: nodes.length, edges: edges.length, orphans: orphanCount, counts })

  const previousCount = simNodes.length
  const structure = `${nodes.length}:${edges.length}:${nodes.map((n) => n.id).join(',')}`
  // Only the force sliders moved: the same graph wants a nudge, not a fresh
  // layout, or every tick of a slider would throw the reader's arrangement out.
  const sameNodes = structure === lastStructure
  lastStructure = structure

  for (const n of simNodes) remembered.set(n.id, { x: n.x, y: n.y })
  // These point at node objects the rebuild is about to replace.
  hovered.value = null
  pinned.value = null
  hoverPoint.value = null

  // Seeded on a spiral rather than d3's phyllotaxis ring: a ring gives every
  // node the same distance from the centre, so the first ticks are a shove
  // outward before any structure appears. Nodes we have seen keep their place.
  simNodes = nodes.map((n, i) => {
    const prev = remembered.get(n.id)
    const a = i * 2.399963
    const rad = 14 * Math.sqrt(i)
    return {
      ...n,
      r: radiusOf(n, n.id === props.rootId),
      x: prev?.x ?? Math.cos(a) * rad,
      y: prev?.y ?? Math.sin(a) * rad,
      vx: 0,
      vy: 0,
    }
  })
  const byId = new Map(simNodes.map((n) => [n.id, n]))

  adjacency.clear()
  simEdges = []
  for (const e of edges) {
    const source = byId.get(e.from)
    const target = byId.get(e.to)
    if (!source || !target) continue
    simEdges.push({ source, target, type: e.type, extractor: e.extractor, inferred: e.extractor === 'inferred' })
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set())
    if (!adjacency.has(e.to)) adjacency.set(e.to, new Set())
    adjacency.get(e.from)!.add(e.to)
    adjacency.get(e.to)!.add(e.from)
  }

  const o = props.options
  const scale = compact.value ? 0.72 : 1
  // More islands need more gathering, or a 40-component workspace fills the
  // plane; a single connected graph needs almost none and reads better loose.
  const gravity = Math.min(0.035 + nodes.length / 5200, 0.115)
  sim.value?.stop()
  const s = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimEdge>(simEdges)
        .id((d) => d.id)
        // Links into a hub are weakened so the hub sits still and its satellites
        // arrange around it, instead of the hub being dragged by every one.
        .distance((l) => (34 + l.source.r + l.target.r) * o.linkDistance * scale)
        .strength((l) => 1 / Math.min(4, Math.max(adjacency.get(l.source.id)?.size ?? 1, adjacency.get(l.target.id)?.size ?? 1))),
    )
    // Repulsion is capped short. Left unbounded, every disconnected cluster
    // pushes every other one away, the graph sprawls, and framing it zooms out
    // until an entity is two pixels of undifferentiated grey — which is the
    // whole reason to draw it at all, gone.
    .force('charge', forceManyBody<SimNode>().strength((d) => -(46 + d.r * 8) * o.repel * scale).distanceMax(320))
    .force('collide', forceCollide<SimNode>((d) => d.r + 6).strength(0.9))
    // Gravity toward the world origin instead of forceCenter: a hard centre
    // translates the whole graph every tick, which reads as drift. Strong
    // enough here to gather the islands into one readable field.
    .force('x', forceX(0).strength(gravity))
    .force('y', forceY(0).strength(gravity))
    .alpha(1)
    .alphaDecay(0.028)
    .velocityDecay(0.42)

  // Reframe on the first draw, and when the population changed enough that the
  // old frame would leave the reader staring at empty space — but not on a
  // small change, because a view that jumps every time a filter is nudged is a
  // view you cannot hold still and read.
  const reframe = !fitted || (!sameNodes && Math.abs(nodes.length - previousCount) > previousCount * 0.25)

  if (reduced) {
    // No settling animation to watch, so settle it before the first paint.
    s.stop()
    for (let i = 0; i < 320; i++) s.tick()
    sim.value = s
    if (reframe) { fit(); fitted = true }
    draw()
    return
  }

  sim.value = s
  if (sameNodes) {
    s.alpha(0.32)
  } else {
    // One free settle before framing, so the opening shot is structure rather
    // than the spiral seed exploding outward.
    s.stop()
    for (let i = 0; i < 90; i++) s.tick()
    s.alpha(0.55)
  }
  // d3's stepper is never used; `frame()` owns integration.
  s.stop()
  if (reframe) { fit(); fitted = true; refitOnSettle = true }
  wake()
}

/* ------------------------------------------------------------- render loop */

function wake() {
  if (running || !canvasEl.value) return
  running = true
  lastFrame = performance.now()
  raf = requestAnimationFrame(frame)
}

function frame(now = performance.now()) {
  const s = sim.value
  // The simulation is integrated here rather than by d3's internal timer.
  // Two independent loops — d3's for physics, ours for painting — means a frame
  // can be drawn from a half-stepped state, and it leaves the physics running
  // on a tab whose canvas is not being drawn at all. One loop that ticks and
  // then paints is both correct and cheaper.
  //
  // Steps are counted against the clock, not against frames: a background tab,
  // a throttled window or a slow machine gets fewer frames, and a layout that
  // settled in four seconds on one machine and forty on another would make
  // "wait for it to settle" advice that is true for nobody.
  const elapsed = Math.min(now - lastFrame, 200)
  lastFrame = now
  const settling = !!s && s.alpha() > s.alphaMin()
  if (s && settling) {
    const steps = Math.min(Math.max(Math.round(elapsed / 16.7), 1), 6)
    for (let i = 0; i < steps && s.alpha() > s.alphaMin(); i++) s.tick()
  }
  // The frame chosen mid-settle is the frame of a layout that had not finished
  // spreading, which is how nodes end up hanging off the bottom edge. Reframe
  // once, on the tick the simulation comes to rest.
  if (!settling && refitOnSettle) {
    refitOnSettle = false
    if (!userFramed) fit()
  }
  const target = focusId.value || props.query ? 1 : 0
  const delta = target - focusMix
  focusMix += delta * (reduced ? 0.5 : 0.22)
  if (Math.abs(delta) < 0.004) focusMix = target

  draw()

  if (settling || focusMix !== target) {
    raf = requestAnimationFrame(frame)
  } else {
    running = false
  }
}

/**
 * A rail widget mounts inside a collapse that animates from zero height, so the
 * first measurement is 0x0 and framing is impossible. Without re-framing when
 * the real size arrives the graph stays parked at the world origin and half of
 * it hangs outside the card — which is exactly what it did.
 */
function resize() {
  const canvas = canvasEl.value
  const host = hostEl.value
  if (!canvas || !host) return
  const rect = host.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const wasUnsized = !width || !height
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = rect.width
  height = rect.height
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  if (wasUnsized || !userFramed) fit()
  else wake()
}

/* ------------------------------------------------------------------- paint */

// Display face, per the system's rule that Sora sets headings and diagram
// labels. Manrope follows it for Cyrillic, which Sora does not cover.
const LABEL_FONT = (size: number, weight = 500) =>
  `${weight} ${size}px Sora, Manrope, ui-sans-serif, system-ui, sans-serif`

/**
 * Ceiling on names drawn in one frame. Past roughly this many, a reader is no
 * longer reading names — they are looking at texture — and every extra one
 * costs a measureText and an overlap scan.
 */
const LABEL_BUDGET = 70

function matches(n: SimNode) {
  const q = props.query.trim().toLowerCase()
  return !!q && n.label.toLowerCase().includes(q)
}

function draw() {
  const canvas = canvasEl.value
  const p = palette.value
  if (!canvas || !p) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.lineCap = 'round'

  const q = props.query.trim().toLowerCase()
  const lit = new Set<string>()
  if (focusId.value) {
    lit.add(focusId.value)
    for (const id of adjacency.get(focusId.value) ?? []) lit.add(id)
  } else if (q) {
    for (const n of simNodes) if (matches(n)) lit.add(n.id)
  }
  const hasFocus = lit.size > 0
  /** 1 while nothing is focused, easing to 0.10 as a neighborhood lights up. */
  const dim = 1 - focusMix * 0.9
  const strength = (id: string) => (!hasFocus || lit.has(id) ? 1 : dim)

  /* ---- edges. Two passes so a lit edge is never drawn under a dim one. */
  const k = view.k
  for (const pass of [0, 1] as const) {
    for (const e of simEdges) {
      const isLit = hasFocus && lit.has(e.source.id) && lit.has(e.target.id)
      if ((pass === 1) !== isLit) continue
      const a = isLit ? 0.55 + focusMix * 0.25 : 0.2 * strength(e.source.id) * strength(e.target.id)
      if (a < 0.012) continue
      ctx.globalAlpha = 1
      ctx.strokeStyle = isLit ? rgba(p.primary, a) : rgba(p.foreground, a)
      ctx.lineWidth = (isLit ? 1.5 : 1) * Math.min(Math.max(k, 0.6), 1.4)
      // Provenance survives the redesign: a dashed link is a claim the model
      // made, a solid one is a claim a person wrote down.
      ctx.setLineDash(e.inferred ? [2.5 * k, 3 * k] : [])
      ctx.beginPath()
      ctx.moveTo(toScreenX(e.source.x), toScreenY(e.source.y))
      ctx.lineTo(toScreenX(e.target.x), toScreenY(e.target.y))
      ctx.stroke()
    }
  }
  ctx.setLineDash([])

  /* ---- nodes */
  const labels: { n: SimNode; x: number; y: number; a: number; rank: number }[] = []
  const showAll = k >= props.options.labelZoom
  for (const n of simNodes) {
    const x = toScreenX(n.x)
    const y = toScreenY(n.y)
    const r = n.r * k
    if (x < -r - 80 || x > width + r + 80 || y < -r - 60 || y > height + r + 60) continue

    const isRoot = n.id === props.rootId
    const isFocus = n.id === focusId.value
    const a = strength(n.id)
    const base = n.kind === 'document' ? p.primary : entityColor(p, n.entityType)

    // The one glow in the system, and it marks structure: the page this graph
    // is about, or the one under the pointer.
    if ((isRoot || isFocus) && a > 0.5 && r > 2) {
      const halo = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 4.2)
      halo.addColorStop(0, rgba(base, 0.3))
      halo.addColorStop(1, rgba(base, 0))
      ctx.globalAlpha = isFocus ? focusMix : 0.85
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(x, y, r * 4.2, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.globalAlpha = 1
    if (n.kind === 'document') {
      // Filled disc: a page is a thing that exists. Its rim is the lifecycle
      // dot from the tree, so "not indexed yet" is legible without a legend.
      ctx.fillStyle = rgba(isRoot ? mix(base, p.foreground, 0.08) : base, a)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      const status = n.status === 'indexed' ? null : n.status === 'failed' ? p.status.failed
        : n.status === 'indexing' || n.status === 'finalized' ? p.status.indexing
        : n.status ? null : p.status.draft
      if (status && r > 3) {
        ctx.strokeStyle = rgba(status, a)
        ctx.lineWidth = Math.max(1.4, r * 0.22)
        ctx.beginPath()
        ctx.arc(x, y, r + ctx.lineWidth * 0.6, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (isFocus || isRoot) {
        ctx.strokeStyle = rgba(p.background, Math.min(a, 0.9))
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2)
        ctx.stroke()
      }
    } else {
      // Ring on the page ground: an entity is a thing pages *point at*, not a
      // thing that holds content. Shape still separates the two kinds, the way
      // the round-rect used to, but at a scale that survives 300 nodes.
      ctx.fillStyle = rgba(p.background, a)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = rgba(base, a * (isFocus ? 1 : 0.85))
      ctx.lineWidth = Math.max(1.2, r * 0.34)
      ctx.stroke()
    }

    // Loud enough to name unasked: hubs, the root, the lit neighborhood, and
    // search hits. Everything else waits for the reader to zoom in.
    const loud = isRoot || isFocus || (hasFocus && lit.has(n.id)) || (n.degree ?? 0) >= 6 || matches(n)
    if ((showAll || loud) && r > 1.5) {
      // Rank decides who keeps their name when two would overlap. What the
      // reader asked about outranks what the graph thinks is important.
      const rank =
        (isFocus ? 4000 : 0) +
        (isRoot ? 3000 : 0) +
        (hasFocus && lit.has(n.id) ? 2000 : 0) +
        (matches(n) ? 1500 : 0) +
        (n.kind === 'document' ? 400 : 0) +
        (n.degree ?? 0)
      // Alpha is the node's own, never boosted: a name left at full strength
      // over a dimmed node makes the label layer opt out of the focus, which
      // is the one gesture the whole graph is built around.
      labels.push({ n, x, y: y + r + (compact.value ? 8 : 10), a, rank })
    }
  }

  /* ---- labels last, so no node is drawn over its neighbor's name.
     A name that overlaps another name is worse than no name: the old graph's
     failure was exactly this, a cluster of titles printed on top of each other
     until the block was unreadable and told you nothing. So the highest-ranked
     label claims its box, and anything that would collide with an already
     placed one is simply not drawn — the reader zooms in to get it. */
  const size = compact.value ? 10 : 11.5
  const lineH = size + 4
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  labels.sort((a, b) => b.rank - a.rank)

  const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
  let drawn = 0
  for (const l of labels) {
    if (l.a < 0.16 || drawn >= LABEL_BUDGET) continue
    const isDoc = l.n.kind === 'document'
    ctx.font = LABEL_FONT(isDoc ? size + 0.5 : size - 1, isDoc ? 600 : 500)
    const text = clip(ctx, l.n.label, compact.value ? 96 : 132)
    const half = ctx.measureText(text).width / 2 + 2
    const box = { x0: l.x - half, y0: l.y - 1, x1: l.x + half, y1: l.y + lineH }
    if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) continue
    placed.push(box)
    drawn++

    // A halo of the page ground instead of a filled box: the old renderer's
    // label backgrounds were what turned a dense graph into a black wall.
    ctx.globalAlpha = l.a
    ctx.strokeStyle = rgba(p.background, 0.92)
    ctx.lineWidth = 3.5
    ctx.strokeText(text, l.x, l.y)
    ctx.fillStyle = rgba(isDoc ? p.foreground : p.muted, isDoc ? 1 : 0.95)
    ctx.fillText(text, l.x, l.y)
  }
  ctx.globalAlpha = 1
}

const clipCache = new Map<string, string>()
function clip(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const key = `${ctx.font}|${max}|${text}`
  const hit = clipCache.get(key)
  if (hit !== undefined) return hit
  let out = text
  if (ctx.measureText(text).width > max) {
    let lo = 1
    let hi = text.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
      else hi = mid - 1
    }
    out = `${text.slice(0, lo).trimEnd()}…`
  }
  if (clipCache.size > 4000) clipCache.clear()
  clipCache.set(key, out)
  return out
}

/* ------------------------------------------------------------- interaction */

function pick(px: number, py: number): SimNode | null {
  let best: SimNode | null = null
  let bestD = Infinity
  for (const n of simNodes) {
    const dx = px - toScreenX(n.x)
    const dy = py - toScreenY(n.y)
    const d = dx * dx + dy * dy
    // A generous target: a 4px entity ring is not a click target at 1x.
    const hit = Math.max(n.r * view.k + 6, 11)
    if (d <= hit * hit && d < bestD) { best = n; bestD = d }
  }
  return best
}

let drag: { node: SimNode | null; startX: number; startY: number; ox: number; oy: number; moved: boolean } | null = null

function local(e: PointerEvent) {
  const rect = canvasEl.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const { x, y } = local(e)
  const node = pick(x, y)
  canvasEl.value?.setPointerCapture(e.pointerId)
  drag = { node, startX: x, startY: y, ox: view.x, oy: view.y, moved: false }
  if (node && !reduced) {
    sim.value?.alphaTarget(0.32)
    node.fx = node.x
    node.fy = node.y
  }
  wake()
}

function onPointerMove(e: PointerEvent) {
  const { x, y } = local(e)
  if (!drag) {
    const node = pick(x, y)
    hovered.value = node
    hoverPoint.value = node ? { x: toScreenX(node.x), y: toScreenY(node.y) } : null
    if (canvasEl.value) canvasEl.value.style.cursor = node ? 'pointer' : 'grab'
    wake()
    return
  }
  if (Math.abs(x - drag.startX) + Math.abs(y - drag.startY) > 3) drag.moved = true
  if (drag.node) {
    drag.node.fx = (x - view.x) / view.k
    drag.node.fy = (y - view.y) / view.k
    if (reduced) { drag.node.x = drag.node.fx; drag.node.y = drag.node.fy }
  } else {
    userFramed = true
    view.x = drag.ox + (x - drag.startX)
    view.y = drag.oy + (y - drag.startY)
    if (canvasEl.value) canvasEl.value.style.cursor = 'grabbing'
  }
  wake()
}

function onPointerUp(e: PointerEvent) {
  const d = drag
  drag = null
  canvasEl.value?.releasePointerCapture?.(e.pointerId)
  if (canvasEl.value) canvasEl.value.style.cursor = 'grab'
  if (!d) return
  if (d.node) {
    if (!reduced) sim.value?.alphaTarget(0)
    // Released back into the simulation rather than pinned. Pulling a cluster
    // out and watching the rest of the graph answer is how you feel what is
    // attached to what; a node that stayed where it was dropped would turn
    // every exploratory tug into a layout edit the reader has to undo.
    d.node.fx = null
    d.node.fy = null
  }
  if (d.moved) { wake(); return }

  if (!d.node) { pinned.value = null; emit('select', null); wake(); return }
  if (d.node.kind === 'document' && d.node.id !== props.rootId) {
    emit('open', d.node.id)
    return
  }
  pinned.value = pinned.value?.id === d.node.id ? null : d.node
  emit('select', pinned.value)
  wake()
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = canvasEl.value!.getBoundingClientRect()
  zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top)
}

function onLeave() {
  hovered.value = null
  hoverPoint.value = null
  wake()
}

function onKeydown(e: KeyboardEvent) {
  const step = 60
  const map: Record<string, () => void> = {
    ArrowLeft: () => { view.x += step },
    ArrowRight: () => { view.x -= step },
    ArrowUp: () => { view.y += step },
    ArrowDown: () => { view.y -= step },
    '+': () => zoomBy(1.25),
    '=': () => zoomBy(1.25),
    '-': () => zoomBy(0.8),
    '0': () => fit(),
    Escape: () => { pinned.value = null; emit('select', null) },
  }
  const fn = map[e.key]
  if (!fn) return
  e.preventDefault()
  fn()
  wake()
}

/* -------------------------------------------------------------- lifecycle */

let themeObserver: MutationObserver | null = null

onMounted(() => {
  if (hostEl.value) palette.value = readPalette(hostEl.value)
  resize()
  build()
  themeObserver = new MutationObserver(() => {
    if (hostEl.value) palette.value = readPalette(hostEl.value)
    wake()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

// resize() reframes on its own when the reader has not taken framing over, so
// a widget that grows into place lands framed rather than parked at the origin.
useResizeObserver(hostEl, () => resize())

// Three different costs, so three different watchers. Rebuilding the whole
// simulation because a label-density slider moved would restart the layout
// under the reader's hand.
watch([() => props.nodes, () => props.edges, () => props.rootId], () => build())
watch(
  () => [
    props.options.showEntities,
    props.options.showOrphans,
    props.options.showInferred,
    props.options.hidden.join(','),
    props.options.repel,
    props.options.linkDistance,
  ].join('|'),
  () => build(),
)
watch([() => props.options.labelZoom, () => props.query], () => wake())

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  running = false
  sim.value?.stop()
  themeObserver?.disconnect()
})

/* ------------------------------------------------------------- node card */

const cardStyle = computed(() => {
  const pt = hoverPoint.value
  if (!pt) return undefined
  const flip = pt.x > width - 200
  return {
    left: `${Math.round(flip ? pt.x - 12 : pt.x + 12)}px`,
    top: `${Math.round(Math.min(Math.max(pt.y, 8), Math.max(height - 84, 8)))}px`,
    transform: flip ? 'translateX(-100%)' : undefined,
  }
})

const cardRelations = computed(() => {
  const id = focusId.value
  if (!id) return []
  const seen = new Map<string, number>()
  for (const e of simEdges) {
    if (e.source.id !== id && e.target.id !== id) continue
    seen.set(e.type, (seen.get(e.type) ?? 0) + 1)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
})

/** Every page in the graph, as real links — the keyboard and screen-reader route. */
const documentNodes = computed(() => projection.value.nodes.filter((n) => n.kind === 'document'))
</script>

<template>
  <div ref="hostEl" class="relative size-full overflow-hidden">
    <canvas
      ref="canvasEl"
      tabindex="0"
      role="application"
      class="size-full cursor-grab touch-none outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      :aria-label="t('graph.canvasLabel', { nodes: projection.nodes.length, edges: projection.edges.length })"
      :aria-describedby="`${uid}-help`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onLeave"
      @wheel="onWheel"
      @keydown="onKeydown"
    />

    <p :id="`${uid}-help`" class="sr-only">{{ t('graph.keyboardHelp') }}</p>

    <!-- The graph must never be the only route to a page (PRODUCT.md). Real
         links, off-screen, so Tab and a screen reader reach every node. -->
    <ul class="sr-only">
      <li v-for="n in documentNodes" :key="n.id">
        <a :href="`/documents/${n.id}`" @click.prevent="emit('open', n.id)">{{ n.label }}</a>
      </li>
    </ul>

    <div
      v-if="isEmpty"
      class="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground"
    >
      {{ t('graph.nothingToShow') }}
    </div>

    <!-- Reads the one node under the pointer. What an edge label used to say,
         said once, for the thing actually being asked about. -->
    <Transition name="kn-fade">
      <div
        v-if="focusNode && hoverPoint"
        class="pointer-events-none absolute z-10 max-w-60 rounded-lg border bg-card/95 px-2.5 py-2 shadow-[0_16px_48px_-12px] shadow-foreground/20 backdrop-blur-sm dark:shadow-black/60"
        :style="cardStyle"
      >
        <p class="truncate font-display text-[0.8rem] font-semibold leading-tight">{{ focusNode.label }}</p>
        <p class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.68rem] text-muted-foreground">
          <span class="rounded-full border px-1.5 py-px">
            {{ focusNode.kind === 'document' ? t('graph.kindPage') : (focusNode.entityType ?? t('graph.kindEntity')) }}
          </span>
          <span>{{ t('graph.linkCount', { n: focusNode.degree ?? 0 }, focusNode.degree ?? 0) }}</span>
        </p>
        <p v-if="cardRelations.length" class="mt-1 truncate font-mono text-[0.64rem] text-muted-foreground/80">
          {{ cardRelations.map(([type, n]) => (n > 1 ? `${type} ×${n}` : type)).join(' · ') }}
        </p>
      </div>
    </Transition>
  </div>
</template>
