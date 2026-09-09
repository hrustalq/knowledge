<script setup lang="ts">
/**
 * Freeform diagram canvas — the Excalidraw-shaped surface, built natively in
 * Vue because Excalidraw itself is React-only and this app server-renders.
 *
 * Two decisions carry the whole component:
 *
 * 1. **Colors are palette keys, never hex.** A scene stores `stroke: 'blue'`
 *    and the renderer emits `var(--kn-draw-blue)`, so a diagram drawn in light
 *    mode stays legible in dark mode. Every whiteboard that bakes hex into the
 *    scene fails this, and the failure is invisible until someone flips theme.
 *
 * 2. **Geometry lives in lib/markdown/drawing.ts**, shared with the read view's
 *    static renderer. The published page and the editing canvas cannot drift.
 */
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import {
  ArrowRight,
  Circle,
  Diamond,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-vue-next'
import {
  DEFAULT_STYLE,
  DRAW_COLORS,
  DRAW_FILLS,
  arrowDefs,
  bounds,
  colorVar,
  dashArray,
  elementMarkup,
  fillValue,
  parseScene,
  serializeScene,
  type DrawColor,
  type DrawElement,
  type DrawFill,
  type DrawScene,
  type DrawStyle,
  type DrawTool,
  type ShapeKind,
} from '@/lib/markdown/drawing'

const { t } = useI18n()

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [string]; close: [] }>()

const TOOLS: { id: DrawTool; icon: unknown; label: string; key: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'whiteboard.select', key: 'V' },
  { id: 'rect', icon: Square, label: 'whiteboard.rectangle', key: 'R' },
  { id: 'ellipse', icon: Circle, label: 'whiteboard.ellipse', key: 'O' },
  { id: 'diamond', icon: Diamond, label: 'whiteboard.diamond', key: 'D' },
  { id: 'arrow', icon: ArrowRight, label: 'whiteboard.arrow', key: 'A' },
  { id: 'line', icon: Minus, label: 'whiteboard.line', key: 'L' },
  { id: 'draw', icon: Pencil, label: 'whiteboard.draw', key: 'P' },
  { id: 'text', icon: Type, label: 'whiteboard.text', key: 'T' },
]

const GRID = 8

const svgEl = ref<SVGSVGElement | null>(null)
const scene = ref<DrawScene>(parseScene(props.modelValue))
const tool = ref<DrawTool>('select')
const style = ref<DrawStyle>({ ...DEFAULT_STYLE })
const selectedId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const textDraft = ref('')
const textInput = ref<HTMLTextAreaElement | null>(null)

const past: string[] = []
const future: string[] = []

/** A gesture in progress: creating, moving, resizing or dragging a line end. */
type Gesture =
  | { kind: 'create'; id: string; ox: number; oy: number; shift: boolean }
  | { kind: 'move'; id: string; ox: number; oy: number; sx: number; sy: number; pts?: [number, number][] }
  | { kind: 'resize'; id: string; anchor: string; start: DrawElement }
  | { kind: 'endpoint'; id: string; index: number }
let gesture: Gesture | null = null

const selected = computed(() => scene.value.els.find((e) => e.id === selectedId.value) ?? null)

watch(
  () => props.modelValue,
  (next) => {
    // Only adopt an external scene when it is genuinely different, or every
    // local edit would echo back and clobber the pointer gesture in flight.
    if (next !== serializeScene(scene.value)) scene.value = parseScene(next)
  },
)

function commit(record = true) {
  if (record) {
    past.push(serializeScene({ ...scene.value, els: scene.value.els.map((e) => ({ ...e })) }))
    if (past.length > 100) past.shift()
    future.length = 0
  }
  emit('update:modelValue', serializeScene(scene.value))
}

function snapshot() {
  past.push(serializeScene(scene.value))
  if (past.length > 100) past.shift()
  future.length = 0
}

function undo() {
  const previous = past.pop()
  if (!previous) return
  future.push(serializeScene(scene.value))
  scene.value = parseScene(previous)
  selectedId.value = null
  emit('update:modelValue', serializeScene(scene.value))
}

function redo() {
  const next = future.pop()
  if (!next) return
  past.push(serializeScene(scene.value))
  scene.value = parseScene(next)
  selectedId.value = null
  emit('update:modelValue', serializeScene(scene.value))
}

/** Client pixels → scene units. The SVG scales, so the ratio is not 1. */
function toScene(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const svg = svgEl.value
  if (!svg) return { x: 0, y: 0 }
  const rect = svg.getBoundingClientRect()
  const scale = scene.value.w / rect.width
  return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale }
}

function snap(value: number, disabled: boolean): number {
  return disabled ? Math.round(value) : Math.round(value / GRID) * GRID
}

function hitTest(x: number, y: number): DrawElement | null {
  // Reverse order: the topmost element wins, matching paint order.
  for (let i = scene.value.els.length - 1; i >= 0; i -= 1) {
    const el = scene.value.els[i]
    if (el.t === 'line' || el.t === 'arrow' || el.t === 'draw') {
      const pts = (el.pts ?? []).map(([px, py]) => [el.x + px, el.y + py] as [number, number])
      const tolerance = Math.max(el.s.sw * 3, 8)
      for (let j = 0; j < pts.length - 1; j += 1) {
        if (distanceToSegment(x, y, pts[j], pts[j + 1]) <= tolerance) return el
      }
      continue
    }
    const b = bounds(el)
    if (x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4) return el
  }
  return null
}

function distanceToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSq))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function onPointerDown(event: PointerEvent) {
  if (editingId.value) commitText()
  const { x, y } = toScene(event)
  ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)

  if (tool.value === 'select') {
    const hit = hitTest(x, y)
    selectedId.value = hit?.id ?? null
    if (!hit) return
    snapshot()
    gesture = {
      kind: 'move',
      id: hit.id,
      ox: x - hit.x,
      oy: y - hit.y,
      sx: hit.x,
      sy: hit.y,
    }
    return
  }

  snapshot()
  const id = newId()
  const kind = tool.value as ShapeKind
  const base: DrawElement = {
    id,
    t: kind,
    x: snap(x, event.altKey),
    y: snap(y, event.altKey),
    w: 0,
    h: 0,
    s: { ...style.value },
  }
  if (kind === 'draw' || kind === 'line' || kind === 'arrow') base.pts = [[0, 0]]
  if (kind === 'text') {
    base.w = 220
    base.h = (style.value.fs ?? 16) * 1.4
    base.text = ''
    scene.value.els.push(base)
    selectedId.value = id
    commit(false)
    startTextEdit(id)
    tool.value = 'select'
    return
  }
  scene.value.els.push(base)
  selectedId.value = id
  gesture = { kind: 'create', id, ox: x, oy: y, shift: event.shiftKey }
}

function onPointerMove(event: PointerEvent) {
  if (!gesture) return
  const { x, y } = toScene(event)
  const el = scene.value.els.find((e) => e.id === gesture!.id)
  if (!el) return

  if (gesture.kind === 'create') {
    if (el.t === 'draw') {
      el.pts?.push([x - el.x, y - el.y])
    } else if (el.t === 'line' || el.t === 'arrow') {
      let ex = snap(x, event.altKey) - el.x
      let ey = snap(y, event.altKey) - el.y
      // Shift constrains to the nearest 45°, the one alignment aid people
      // reach for without being told it exists.
      if (event.shiftKey) {
        const angle = Math.round(Math.atan2(ey, ex) / (Math.PI / 4)) * (Math.PI / 4)
        const length = Math.hypot(ex, ey)
        ex = Math.round(Math.cos(angle) * length)
        ey = Math.round(Math.sin(angle) * length)
      }
      el.pts = [
        [0, 0],
        [ex, ey],
      ]
      el.w = ex
      el.h = ey
    } else {
      let w = snap(x, event.altKey) - el.x
      let h = snap(y, event.altKey) - el.y
      if (event.shiftKey) {
        const size = Math.max(Math.abs(w), Math.abs(h))
        w = Math.sign(w || 1) * size
        h = Math.sign(h || 1) * size
      }
      el.w = w
      el.h = h
    }
  } else if (gesture.kind === 'move') {
    el.x = snap(x - gesture.ox, event.altKey)
    el.y = snap(y - gesture.oy, event.altKey)
  } else if (gesture.kind === 'resize') {
    resizeFrom(el, gesture.start, gesture.anchor, x, y, event.altKey)
  } else if (gesture.kind === 'endpoint' && el.pts) {
    el.pts[gesture.index] = [snap(x, event.altKey) - el.x, snap(y, event.altKey) - el.y]
  }
  commit(false)
}

function resizeFrom(
  el: DrawElement,
  start: DrawElement,
  anchor: string,
  x: number,
  y: number,
  raw: boolean,
) {
  const b = bounds(start)
  let { x: nx, y: ny, w: nw, h: nh } = b
  if (anchor.includes('e')) nw = snap(x, raw) - b.x
  if (anchor.includes('s')) nh = snap(y, raw) - b.y
  if (anchor.includes('w')) {
    nx = snap(x, raw)
    nw = b.x + b.w - nx
  }
  if (anchor.includes('n')) {
    ny = snap(y, raw)
    nh = b.y + b.h - ny
  }
  el.x = nx
  el.y = ny
  el.w = Math.max(nw, 8)
  el.h = Math.max(nh, 8)
}

function onPointerUp() {
  if (!gesture) return
  const el = scene.value.els.find((e) => e.id === gesture!.id)
  // A click with the shape tool active produces a zero-size shape; give it a
  // sensible default box instead of leaving an invisible artifact behind.
  if (el && gesture.kind === 'create' && el.t !== 'draw' && el.t !== 'line' && el.t !== 'arrow') {
    if (Math.abs(el.w) < 4 && Math.abs(el.h) < 4) {
      el.w = 140
      el.h = 80
    }
  }
  if (el && gesture.kind === 'create' && el.t === 'draw' && (el.pts?.length ?? 0) < 2) {
    scene.value.els = scene.value.els.filter((e) => e.id !== el.id)
  }
  gesture = null
  if (tool.value !== 'select' && tool.value !== 'draw') tool.value = 'select'
  commit(false)
}

function startResize(anchor: string, event: PointerEvent) {
  const el = selected.value
  if (!el) return
  event.stopPropagation()
  snapshot()
  gesture = { kind: 'resize', id: el.id, anchor, start: { ...el } }
  ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
}

function startEndpoint(index: number, event: PointerEvent) {
  const el = selected.value
  if (!el) return
  event.stopPropagation()
  snapshot()
  gesture = { kind: 'endpoint', id: el.id, index }
  ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
}

function startTextEdit(id: string) {
  const el = scene.value.els.find((e) => e.id === id)
  if (!el || el.t === 'draw' || el.t === 'line' || el.t === 'arrow') return
  editingId.value = id
  textDraft.value = el.text ?? ''
  void nextTick(() => {
    textInput.value?.focus()
    textInput.value?.select()
  })
}

function commitText() {
  const id = editingId.value
  editingId.value = null
  if (!id) return
  const el = scene.value.els.find((e) => e.id === id)
  if (!el) return
  const next = textDraft.value
  if ((el.text ?? '') === next) return
  snapshot()
  el.text = next
  // A text element with nothing in it is invisible and unselectable — drop it
  // rather than leaving a trap on the canvas.
  if (el.t === 'text' && !next.trim()) {
    scene.value.els = scene.value.els.filter((e) => e.id !== id)
    selectedId.value = null
  }
  commit(false)
}

function removeSelected() {
  if (!selectedId.value) return
  snapshot()
  scene.value.els = scene.value.els.filter((e) => e.id !== selectedId.value)
  selectedId.value = null
  commit(false)
}

function applyStyle(patch: Partial<DrawStyle>) {
  style.value = { ...style.value, ...patch }
  const el = selected.value
  if (!el) return
  snapshot()
  el.s = { ...el.s, ...patch }
  commit(false)
}

function onKeydown(event: KeyboardEvent) {
  if (editingId.value) return
  const meta = event.metaKey || event.ctrlKey
  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault()
    removeSelected()
    return
  }
  if (event.key === 'Escape') {
    selectedId.value = null
    emit('close')
    return
  }
  const match = TOOLS.find((t) => t.key.toLowerCase() === event.key.toLowerCase())
  if (match && !meta) {
    event.preventDefault()
    tool.value = match.id
  }
}

/** Selection chrome geometry. */
const selectionBox = computed(() => (selected.value ? bounds(selected.value) : null))
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
function handlePoint(anchor: string): { x: number; y: number } {
  const b = selectionBox.value!
  return {
    x: anchor.includes('w') ? b.x : anchor.includes('e') ? b.x + b.w : b.x + b.w / 2,
    y: anchor.includes('n') ? b.y : anchor.includes('s') ? b.y + b.h : b.y + b.h / 2,
  }
}

const isPathShape = computed(
  () => !!selected.value && ['line', 'arrow', 'draw'].includes(selected.value.t),
)

function editorTextBox(el: DrawElement) {
  const b = bounds(el)
  const svg = svgEl.value
  const rect = svg?.getBoundingClientRect()
  const scale = rect ? rect.width / scene.value.w : 1
  return {
    left: `${b.x * scale}px`,
    top: `${b.y * scale}px`,
    width: `${Math.max(b.w, 80) * scale}px`,
    height: `${Math.max(b.h, 24) * scale}px`,
    fontSize: `${(el.s.fs ?? 16) * scale}px`,
  }
}

function resize(delta: number) {
  scene.value.h = Math.max(240, Math.min(1600, scene.value.h + delta))
  commit(false)
}
</script>

<template>
  <div class="kn-wb" @keydown="onKeydown" tabindex="-1">
    <!-- Tools -->
    <div class="kn-wb-bar" role="toolbar" :aria-label="t('whiteboard.tools')">
      <div class="kn-wb-group">
        <button
          v-for="item in TOOLS"
          :key="item.id"
          type="button"
          class="kn-wb-tool"
          :aria-pressed="tool === item.id"
          :title="t('whiteboard.toolWithKey', { label: t(item.label), key: item.key })"
          @click="tool = item.id"
        >
          <component :is="item.icon" class="size-4" />
        </button>
      </div>

      <div class="kn-wb-group" :aria-label="t('whiteboard.strokeColor')">
        <button
          v-for="c in DRAW_COLORS"
          :key="c"
          type="button"
          class="kn-wb-swatch"
          :style="{ background: colorVar(c as DrawColor) }"
          :aria-pressed="style.stroke === c"
          :title="t('whiteboard.strokeValue', { value: c })"
          @click="applyStyle({ stroke: c as DrawColor })"
        />
      </div>

      <div class="kn-wb-group" :aria-label="t('whiteboard.fill')">
        <button
          v-for="f in DRAW_FILLS"
          :key="f"
          type="button"
          class="kn-wb-swatch kn-wb-swatch-fill"
          :style="{ background: fillValue(f as DrawFill), borderColor: f === 'none' ? undefined : colorVar(f as DrawColor) }"
          :aria-pressed="style.fill === f"
          :title="t('whiteboard.fillValue', { value: f })"
          @click="applyStyle({ fill: f as DrawFill })"
        >
          <span v-if="f === 'none'" class="kn-wb-none" />
        </button>
      </div>

      <div class="kn-wb-group" :aria-label="t('whiteboard.strokeWidth')">
        <button
          v-for="w in [1, 2, 4]"
          :key="w"
          type="button"
          class="kn-wb-tool kn-wb-weight"
          :aria-pressed="style.sw === w"
          :title="t('whiteboard.strokeWidthValue', { value: w })"
          @click="applyStyle({ sw: w })"
        >
          <span :style="{ height: `${w}px` }" />
        </button>
      </div>

      <div class="kn-wb-group" :aria-label="t('whiteboard.strokeStyle')">
        <button
          v-for="d in ([0, 1, 2] as const)"
          :key="d"
          type="button"
          class="kn-wb-tool kn-wb-dash"
          :aria-pressed="style.dash === d"
          :title="[t('whiteboard.solid'), t('whiteboard.dashed'), t('whiteboard.dotted')][d]"
          @click="applyStyle({ dash: d })"
        >
          <svg viewBox="0 0 16 2" class="w-4"><line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" stroke-width="2" :stroke-dasharray="dashArray(d, 2)" /></svg>
        </button>
      </div>

      <div class="kn-wb-group ml-auto">
        <button type="button" class="kn-wb-tool" :title="t('toolbar.undo')" :disabled="past.length === 0" @click="undo">
          <Undo2 class="size-4" />
        </button>
        <button type="button" class="kn-wb-tool" :title="t('toolbar.redo')" :disabled="future.length === 0" @click="redo">
          <Redo2 class="size-4" />
        </button>
        <button
          type="button"
          class="kn-wb-tool"
          :title="t('whiteboard.deleteSelection')"
          :disabled="!selectedId"
          @click="removeSelected"
        >
          <Trash2 class="size-4" />
        </button>
      </div>
    </div>

    <!-- Canvas -->
    <div class="kn-wb-stage">
      <svg
        ref="svgEl"
        class="kn-wb-canvas"
        :class="tool === 'select' ? 'cursor-default' : 'cursor-crosshair'"
        :viewBox="`0 0 ${scene.w} ${scene.h}`"
        :style="{ aspectRatio: `${scene.w} / ${scene.h}` }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="selectedId && startTextEdit(selectedId)"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- generated from our own scene model, never user HTML -->
        <g v-html="arrowDefs()" />
        <g v-for="el in scene.els" :key="el.id" v-html="elementMarkup(el)" />

        <g v-if="selectionBox" class="kn-wb-selection" pointer-events="none">
          <rect
            :x="selectionBox.x - 4"
            :y="selectionBox.y - 4"
            :width="selectionBox.w + 8"
            :height="selectionBox.h + 8"
            fill="none"
            stroke="var(--primary)"
            stroke-width="1.5"
            stroke-dasharray="4 3"
            rx="3"
          />
        </g>
        <template v-if="selectionBox && !isPathShape">
          <rect
            v-for="a in HANDLES"
            :key="a"
            class="kn-wb-handle"
            :x="handlePoint(a).x - 5"
            :y="handlePoint(a).y - 5"
            width="10"
            height="10"
            rx="2"
            @pointerdown="startResize(a, $event)"
          />
        </template>
        <template v-if="selectionBox && isPathShape && selected?.pts && selected.t !== 'draw'">
          <circle
            v-for="(p, i) in selected.pts"
            :key="i"
            class="kn-wb-handle"
            :cx="selected.x + p[0]"
            :cy="selected.y + p[1]"
            r="6"
            @pointerdown="startEndpoint(i, $event)"
          />
        </template>
      </svg>

      <!-- Text editing overlays the shape so what you type sits where it lands. -->
      <textarea
        v-if="editingId && scene.els.find((e) => e.id === editingId)"
        ref="textInput"
        v-model="textDraft"
        class="kn-wb-text-input"
        :style="editorTextBox(scene.els.find((e) => e.id === editingId)!)"
        @blur="commitText"
        @keydown.escape.prevent="commitText"
        @keydown.enter.exact.prevent="commitText"
      />

      <div v-if="scene.els.length === 0" class="kn-wb-empty" aria-hidden="true">
        <i18n-t keypath="whiteboard.emptyHint" tag="span" scope="global">
          <template #select><kbd>V</kbd></template>
          <template #pencil><kbd>P</kbd></template>
        </i18n-t>
      </div>
    </div>

    <div class="kn-wb-foot">
      <span class="text-xs text-muted-foreground">{{ t('count.objects', { n: scene.els.length }, scene.els.length) }}</span>
      <div class="ml-auto flex items-center gap-1">
        <button type="button" class="kn-wb-tool" :title="t('whiteboard.shorter')" @click="resize(-120)">−</button>
        <span class="text-xs tabular-nums text-muted-foreground">{{ scene.w }}×{{ scene.h }}</span>
        <button type="button" class="kn-wb-tool" :title="t('whiteboard.taller')" @click="resize(120)">+</button>
      </div>
    </div>
  </div>
</template>
