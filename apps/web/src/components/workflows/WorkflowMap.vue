<script setup lang="ts">
/**
 * A workflow drawn, wherever it is read rather than edited.
 *
 * Built the way `KnowledgeGraph` is built — canvas, a palette probed off the
 * live stylesheet so both themes are correct without a second set of colors, a
 * render loop that parks itself the moment nothing is moving — and laid out by
 * `workflow-layout`, which the editor's Tidy up also calls. The editor stays in
 * Vue Flow because editing needs real DOM handles to grab; reading does not,
 * and a rail-sized preview built out of DOM nodes is a dozen elements carrying
 * connection points nobody can reach.
 *
 * Three rules carried over from that graph, and one that is new here:
 *
 * - **Labels are earned.** At `mini` nothing is named: a 6rem preview is a
 *   shape, and a shape with eight truncated titles in it is a smudge.
 * - **Hover is a query.** Lighting one step and its edges answers "what does
 *   this feed" without a click or a panel.
 * - **Motion is information.** The one thing that animates at rest is a step
 *   that is genuinely working, and it uses the amber indexing pulse — so a
 *   still map means a run that is waiting for somebody.
 * - **A fan-out step is drawn as a stack.** The card that becomes many carries
 *   two more behind it. Shape says what an icon would have had to.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useResizeObserver } from '@vueuse/core'
import type { WorkflowGraph, WorkflowNodeStatus, WorkflowStep } from '@knowledge/contracts'
import { readPalette, rgba, type GraphPalette, type Rgb } from '@/components/graph/graph-theme'
import { labelFor } from '@/lib/labels'
import { edgeCurve, layoutWorkflow, type WorkflowLayout } from './workflow-layout'
import { stepKind } from './workflow-ui'

const props = withDefaults(
  defineProps<{
    graph: WorkflowGraph
    /** Run state per step id. Absent = this is a definition, not a run. */
    statuses?: Record<string, WorkflowNodeStatus>
    /** How many cards exist at a step in a run, shown on the stack. */
    counts?: Record<string, number>
    selectedId?: string | null
    /** `mini` is a thumbnail: fitted, frozen, unlabelled. */
    density?: 'mini' | 'full'
    /** Off makes the canvas inert — a picture, with no pointer affordance. */
    interactive?: boolean
    /** Issues by step id, so a preview can show what will not save. */
    invalid?: string[]
  }>(),
  { statuses: undefined, counts: undefined, selectedId: null, density: 'full', interactive: true, invalid: () => [] },
)

const emit = defineEmits<{ select: [string] }>()

const { t } = useI18n()

const hostEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const palette = shallowRef<GraphPalette | null>(null)
const hovered = ref<string | null>(null)

const mini = computed(() => props.density === 'mini')
const layout = computed<WorkflowLayout>(() =>
  layoutWorkflow(
    props.graph,
    mini.value ? { nodeWidth: 96, nodeHeight: 30, rankGap: 34, nodeGap: 12 } : undefined,
  ),
)
const steps = computed(() => new Map(props.graph.steps.map((s) => [s.id, s])))
const invalidSet = computed(() => new Set(props.invalid))

/** Everything a step touches, for the hover query. */
const adjacency = computed(() => {
  const map = new Map<string, Set<string>>()
  const touch = (a: string, b: string) => {
    if (!map.has(a)) map.set(a, new Set())
    map.get(a)!.add(b)
  }
  for (const step of props.graph.steps) {
    for (const next of step.next) {
      if (!steps.value.has(next)) continue
      touch(step.id, next)
      touch(next, step.id)
    }
  }
  return map
})

const busy = computed(() =>
  Object.values(props.statuses ?? {}).some((s) => s === 'running' || s === 'materializing'),
)

const view = { k: 1, x: 0, y: 0 }
let width = 0
let height = 0
let dpr = 1
let raf = 0
let running = false
let userFramed = false
const reduced =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const PAD = 18

function fit() {
  const l = layout.value
  if (!l.boxes.length || !width || !height) return
  const pad = mini.value ? 8 : PAD
  // The ceiling is above 1 on purpose. A one- or two-step chain laid out at
  // its authored size floats in the middle of a large panel and reads as a
  // failed render; letting a small graph grow into the room it has makes a
  // short chain look short rather than broken.
  const k = Math.min((width - pad * 2) / l.width, (height - pad * 2) / l.height, mini.value ? 1.45 : 1.6)
  view.k = Math.max(k, 0.05)
  view.x = (width - l.width * view.k) / 2
  view.y = (height - l.height * view.k) / 2
  userFramed = false
}

function zoomBy(factor: number, cx = width / 2, cy = height / 2) {
  const next = Math.min(Math.max(view.k * factor, 0.15), 2.5)
  const ratio = next / view.k
  view.x = cx - (cx - view.x) * ratio
  view.y = cy - (cy - view.y) * ratio
  view.k = next
  userFramed = true
  wake()
}

defineExpose({ fit: () => { fit(); wake() }, zoomBy })

/* ------------------------------------------------------------- render loop */

function wake() {
  if (running || !canvasEl.value) return
  running = true
  raf = requestAnimationFrame(frame)
}

function frame() {
  draw()
  // The loop stays open only while something is genuinely in flight. A preview
  // of a finished run holds no animation frame at all, which is the same
  // promise the reading surfaces make about the knowledge graph.
  if (busy.value && !reduced) raf = requestAnimationFrame(frame)
  else running = false
}

/* -------------------------------------------------------------------- paint */

const LABEL_FONT = (size: number, weight = 500) =>
  `${weight} ${size}px Sora, Manrope, ui-sans-serif, system-ui, sans-serif`
const META_FONT = (size: number) => `500 ${size}px ui-sans-serif, system-ui, sans-serif`

/**
 * A step's colour is its run state, read from the very tokens the status dot
 * beside a title uses. Without a run there is no state to show, so a definition
 * draws in ink — the map of a chain that has never been started must not look
 * like a chain that finished.
 */
function statusColor(p: GraphPalette, status: WorkflowNodeStatus | undefined): Rgb | null {
  switch (status) {
    case 'materialized':
    case 'approved':
      return p.status.indexed
    case 'running':
    case 'materializing':
      return p.status.indexing
    case 'awaiting-review':
      return p.status.indexing
    case 'failed':
      return p.status.failed
    case 'rejected':
    case 'skipped':
      return p.status.draft
    default:
      return null
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…`
}

/** What the second line of a card says: its job, then what leaves it. */
function summarize(step: WorkflowStep): string {
  const kind = stepKind(step.kind)
  const label = kind ? t(kind.label) : step.kind
  if (step.fanOut) return `${label} · ${t('workflow.map.many')}`
  // `labelFor`, not a bare `t()`: `documents.category` is free text, so a page
  // filed under `onboarding` would otherwise be labelled `category.onboarding`
  // right on the diagram (docs/features/18).
  if (step.produces) return `${label} · ${labelFor(t, 'category', step.produces.category)}`
  return label
}

const toX = (x: number) => x * view.k + view.x
const toY = (y: number) => y * view.k + view.y

function draw() {
  const canvas = canvasEl.value
  const p = palette.value
  const l = layout.value
  if (!canvas || !p) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const focus = hovered.value ?? props.selectedId ?? null
  const lit = new Set<string>()
  if (focus) {
    lit.add(focus)
    for (const id of adjacency.value.get(focus) ?? []) lit.add(id)
  }
  const dim = (id: string) => (!focus || lit.has(id) ? 1 : 0.24)

  const k = view.k
  const nw = l.nodeWidth * k
  const nh = l.nodeHeight * k

  /* ---- edges, dim pass then lit, so a lit edge is never under a dim one. */
  for (const pass of [0, 1] as const) {
    for (const step of props.graph.steps) {
      const from = l.by[step.id]
      if (!from) continue
      for (const nextId of step.next) {
        const to = l.by[nextId]
        if (!to) continue
        const isLit = !!focus && lit.has(step.id) && lit.has(nextId)
        if ((pass === 1) !== isLit) continue
        const alpha = isLit ? 0.75 : 0.34 * dim(step.id) * dim(nextId)
        if (alpha < 0.02) continue
        const c = edgeCurve(from, to, l.nodeWidth, l.nodeHeight)
        ctx.strokeStyle = isLit ? rgba(p.primary, alpha) : rgba(p.foreground, alpha)
        ctx.lineWidth = Math.max((isLit ? 1.75 : 1.25) * Math.min(k, 1.2), 0.75)
        ctx.beginPath()
        ctx.moveTo(toX(c.x1), toY(c.y1))
        ctx.bezierCurveTo(toX(c.cx1), toY(c.cy1), toX(c.cx2), toY(c.cy2), toX(c.x2), toY(c.y2))
        ctx.stroke()

        // An arrowhead, which the relation graph deliberately does without:
        // there, an edge says two things are connected; here it says which one
        // happens first, and that is the fact the whole diagram exists for.
        if (!mini.value) {
          const size = 4.5 * Math.min(k, 1.2)
          const tipX = toX(c.x2)
          const tipY = toY(c.y2)
          ctx.fillStyle = isLit ? rgba(p.primary, alpha) : rgba(p.foreground, alpha)
          ctx.beginPath()
          ctx.moveTo(tipX, tipY)
          ctx.lineTo(tipX - size * 1.7, tipY - size)
          ctx.lineTo(tipX - size * 1.7, tipY + size)
          ctx.closePath()
          ctx.fill()
        }
      }
    }
  }

  /* ---- nodes */
  for (const box of l.boxes) {
    const step = steps.value.get(box.id)
    if (!step) continue
    const x = toX(box.x)
    const y = toY(box.y)
    const a = dim(box.id)
    const status = props.statuses?.[box.id]
    const accent = statusColor(p, status)
    const selected = props.selectedId === box.id
    const isFocus = hovered.value === box.id
    const bad = invalidSet.value.has(box.id)
    const radius = (mini.value ? 5 : 10) * Math.min(k * 1.4, 1.4)

    // The stack behind a fan-out card: this one becomes many. Not drawn at
    // thumbnail size — a 3px offset on a 17px card is below what the picture
    // can carry, and all it adds there is a smeared edge. At that size the two
    // outgoing edges already say the same thing.
    if (step.fanOut && !mini.value) {
      for (const depth of [2, 1]) {
        const offset = depth * 5 * Math.min(k, 1.2)
        ctx.globalAlpha = a * (0.34 / depth)
        ctx.fillStyle = rgba(p.card, 1)
        roundRect(ctx, x + offset, y + offset, nw, nh, radius)
        ctx.fill()
        ctx.strokeStyle = rgba(p.border, 1)
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    ctx.globalAlpha = a
    ctx.fillStyle = rgba(p.card, 1)
    roundRect(ctx, x, y, nw, nh, radius)
    ctx.fill()

    // Flat by default: the border and the tonal step carry the separation, and
    // the only ring drawn is the focus ring the rest of the system draws.
    if (selected || isFocus) {
      ctx.strokeStyle = rgba(bad ? p.status.failed : p.primary, 1)
      ctx.lineWidth = Math.max(1.5 * Math.min(k, 1.2), 1)
    } else {
      ctx.strokeStyle = rgba(bad ? p.status.failed : p.border, 1)
      ctx.lineWidth = 1
    }
    ctx.stroke()

    if (selected) {
      ctx.strokeStyle = rgba(bad ? p.status.failed : p.primary, 0.16)
      ctx.lineWidth = 3
      roundRect(ctx, x - 2, y - 2, nw + 4, nh + 4, radius + 2)
      ctx.stroke()
    }

    // The lifecycle dot, in the same 6px the tree and the lists use.
    if (accent) {
      const r = mini.value ? 2.5 : 3
      // Against the clock, not against frames: the same run must breathe at the
      // same rate on a throttled tab and on a fast machine, or "it is working"
      // becomes a claim about the reader's hardware.
      const pulse =
        (status === 'running' || status === 'materializing') && !reduced
          ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((performance.now() / 1000) * 3.4))
          : 1
      ctx.globalAlpha = a * pulse
      ctx.fillStyle = rgba(accent, 1)
      ctx.beginPath()
      ctx.arc(x + (mini.value ? 8 : 14), y + nh / 2 - (mini.value ? 0 : 7), r, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = a
    }

    if (mini.value) continue

    const left = x + (accent ? 24 : 14)
    const room = nw - (left - x) - 12
    if (room < 24) continue

    ctx.fillStyle = rgba(p.foreground, a)
    ctx.font = LABEL_FONT(Math.max(11, Math.min(13 * k, 14)), 600)
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(ellipsize(ctx, step.title || step.id, room), left, y + nh / 2 - 1)

    ctx.fillStyle = rgba(p.muted, a)
    ctx.font = META_FONT(Math.max(9.5, Math.min(11 * k, 12)))
    const count = props.counts?.[box.id]
    const meta = count && count > 1 ? `${summarize(step)} · ${count}` : summarize(step)
    ctx.fillText(ellipsize(ctx, meta, room), left, y + nh / 2 + 14)
  }
  ctx.globalAlpha = 1
}

/* ---------------------------------------------------------------- pointer */

function hit(clientX: number, clientY: number): string | null {
  const host = hostEl.value
  const l = layout.value
  if (!host) return null
  const rect = host.getBoundingClientRect()
  const px = clientX - rect.left
  const py = clientY - rect.top
  // Back to front: a fan-out stack overlaps its neighbours, and the card in
  // front is the one under the pointer.
  for (let i = l.boxes.length - 1; i >= 0; i--) {
    const box = l.boxes[i]!
    const x = toX(box.x)
    const y = toY(box.y)
    if (px >= x && px <= x + l.nodeWidth * view.k && py >= y && py <= y + l.nodeHeight * view.k) return box.id
  }
  return null
}

let dragging = false
let dragged = false
let lastX = 0
let lastY = 0

function onPointerMove(e: PointerEvent) {
  if (dragging) {
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    view.x += dx
    view.y += dy
    lastX = e.clientX
    lastY = e.clientY
    // A couple of pixels is a click with an unsteady hand, not a pan; without
    // the threshold, selecting a step on a trackpad almost never lands.
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true
    userFramed = true
    draw()
    return
  }
  if (!props.interactive) return
  const id = hit(e.clientX, e.clientY)
  if (id !== hovered.value) {
    hovered.value = id
    draw()
  }
}

function onPointerDown(e: PointerEvent) {
  if (!props.interactive || mini.value) return
  dragging = true
  dragged = false
  lastX = e.clientX
  lastY = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerUp(e: PointerEvent) {
  if (dragging) {
    dragging = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    // A pan that moved is a pan, not a click on whatever it started over.
    if (dragged) return
  }
  if (!props.interactive) return
  const id = hit(e.clientX, e.clientY)
  if (id) emit('select', id)
}

function onWheel(e: WheelEvent) {
  if (!props.interactive || mini.value) return
  e.preventDefault()
  const host = hostEl.value
  if (!host) return
  const rect = host.getBoundingClientRect()
  zoomBy(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - rect.left, e.clientY - rect.top)
}

/* ------------------------------------------------------------- lifecycle */

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
  // A map inside a collapsible rail widget is measured at 0×0 on its first
  // frame; without re-framing when the real size lands it stays parked at the
  // origin with half of itself outside the card.
  if (wasUnsized || !userFramed || mini.value) fit()
  draw()
  wake()
}

let themeObserver: MutationObserver | null = null

onMounted(() => {
  const host = hostEl.value
  if (!host) return
  palette.value = readPalette(host)
  resize()
  // The palette is re-read rather than re-declared per theme, so a toggle
  // repaints in the right colors without a second table of them.
  themeObserver = new MutationObserver(() => {
    palette.value = readPalette(host)
    draw()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  running = false
  themeObserver?.disconnect()
})

useResizeObserver(hostEl, resize)

watch(
  () => [props.graph, props.statuses, props.selectedId, props.invalid],
  () => {
    if (mini.value || !userFramed) fit()
    draw()
    wake()
  },
  { deep: true },
)

/** The map's text equivalent, and the only thing a screen reader gets from a
 *  canvas — so it has to say what the picture says, not that a picture exists. */
const description = computed(() => {
  const n = props.graph.steps.length
  if (!n) return t('workflow.map.empty')
  return t('workflow.map.summary', {
    steps: t('count.steps', { n }, n),
    chain: props.graph.steps.map((s) => s.title || s.id).join(' → '),
  })
})
</script>

<template>
  <div
    ref="hostEl"
    class="relative size-full overflow-hidden"
    :class="interactive && !mini ? 'cursor-grab active:cursor-grabbing' : ''"
  >
    <canvas
      ref="canvasEl"
      class="block size-full"
      :class="hovered && interactive ? 'cursor-pointer' : ''"
      role="img"
      :aria-label="description"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointerleave="hovered = null; draw()"
      @wheel="onWheel"
    />
    <slot />
  </div>
</template>
