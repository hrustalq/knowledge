<script setup lang="ts">
/**
 * A C4 model full screen (#1244, docs/features/85): to explore it, or —
 * `editable` — to build it the way one draws on a canvas.
 *
 * - The canvas draws the view where its elements were put (core/markdown/c4-svg),
 *   or where `autoLayout` starts them. Drag an element to move it; drag the dot
 *   on its edge onto another to connect them; drag the empty canvas to pan.
 *   Ctrl or a pinch and the wheel zoom; a plain wheel pans.
 * - The palette adds what the view can hold, by click (centre) or drop.
 * - The inspector edits the selected element or relationship, and opens or
 *   creates the view a level down.
 * - The keyboard does all of it too: Tab to an element, arrows move it, Delete
 *   removes it, Enter opens its view, ⌘Z / ⌘⇧Z undo and redo.
 *
 * Nothing is held here but the selection and a drag in flight: every change
 * is an edit of the Structurizr text (core/markdown/structurizr-edit) sent up
 * as `update:source`, so the page's own undo, autosave and collaboration see
 * an ordinary edit, and the next render reads it back.
 */
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useDebounceFn, useElementSize, useEventListener } from '@vueuse/core'
import { ArrowDownToLine, Box, Boxes, Component as ComponentIcon, Maximize, RotateCcw, Trash2, User, X, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@knowledge/ui/dialog'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { Textarea } from '@knowledge/ui/textarea'
import { headerButton } from '@knowledge/ui/lightbox'
import DOMPurify from 'dompurify'
import { NODE_H, NODE_W, positionsOf, renderC4Svg, type C4Positions } from '@/core/markdown/c4-svg'
import {
  C4SyntaxError,
  KIND_LABEL,
  detailViewOf,
  parseStructurizr,
  type C4Element,
  type C4Kind,
  type C4Model,
  type C4Point,
} from '@/core/markdown/structurizr'
import {
  C4EditError,
  addDetailView,
  addElement,
  clearLayout,
  connectElements,
  deleteElement,
  deleteRelationship,
  paletteFor,
  placeElements,
  updateElement,
  updateRelationship,
  type C4ElementPatch,
} from '@/core/markdown/structurizr-edit'
import { sanitizeUntrustedSvg } from '@/shared/utils/untrusted-markdown'
import { nodeAt } from '../model/c4-draw'
import { useC4Levels } from '../model/use-c4-levels'

const props = defineProps<{
  source: string
  editable?: boolean
  /** The view the block was showing: the studio opens on it. */
  viewIndex?: number
  untrusted?: boolean
}>()
const emit = defineEmits<{ 'update:source': [source: string]; close: []; undo: []; redo: [] }>()

const { t } = useI18n()
const title = useC4Levels()

// ── the model ─────────────────────────────────────────────────────────────
const model = shallowRef<C4Model | null>(null)
const problem = ref('')
watch(
  () => props.source,
  (source) => {
    try {
      model.value = parseStructurizr(source)
      problem.value = ''
    } catch (e) {
      // Mid-edit in the Source tab: keep drawing the last model that parsed.
      problem.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)
const vi = ref(props.viewIndex ?? 0)
const view = computed(() => model.value?.views[vi.value] ?? model.value?.views[0] ?? null)
watch(model, (m) => {
  if (m && vi.value >= m.views.length) vi.value = 0
})
const tab = ref<'diagram' | 'source'>('diagram')

// ── selection & drawing ───────────────────────────────────────────────────
type Selection = { node: string } | { rel: number } | null
const selection = ref<Selection>(null)
const selectedNode = computed(() => {
  const s = selection.value
  return s && 'node' in s ? (model.value?.elements.find((e) => e.id === s.node) ?? null) : null
})
const selectedRel = computed(() => {
  const s = selection.value
  return s && 'rel' in s ? (model.value?.relationships[s.rel] ?? null) : null
})

/** A drag in flight: the element's position before the pointer let go. */
const moving = ref<{ id: string; at: C4Point } | null>(null)
const base = computed<C4Positions>(() => (model.value && view.value ? positionsOf(model.value, view.value) : new Map()))
const positions = computed<C4Positions>(() => {
  const m = moving.value
  if (!m) return base.value
  const out = new Map(base.value)
  for (const el of out.keys()) if (el.id === m.id) out.set(el, m.at)
  return out
})
const drawn = computed(() => {
  if (!model.value || !view.value) return { html: '', nodes: [] as C4Element[] }
  const { svg, nodes } = renderC4Svg(model.value, view.value, positions.value, {
    frame: false,
    handles: props.editable,
    selectedNode: selectedNode.value,
    selectedRelationship: selection.value && 'rel' in selection.value ? selection.value.rel : null,
  })
  const html = props.untrusted ? sanitizeUntrustedSvg(svg) : DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
  return { html, nodes }
})
const byIdNow = () => Object.fromEntries([...positions.value].map(([el, p]) => [el.id, p]))

/** Elements take focus and say what they are; one with a view below says so. */
const canvas = ref<HTMLElement | null>(null)
watch(
  () => drawn.value.html,
  async () => {
    await nextTick()
    for (const g of canvas.value?.querySelectorAll<SVGGElement>('g[data-c4-node]') ?? []) {
      const el = drawn.value.nodes[Number(g.dataset.c4Node)]
      if (!el) continue
      const detail = detailViewOf(model.value!, el)
      g.setAttribute('tabindex', '0')
      g.setAttribute('role', 'button')
      g.setAttribute('aria-label', detail ? t('c4.open', { name: el.name, view: title(detail) }) : `${el.name}, ${KIND_LABEL[el.kind]}`)
      if (detail) g.classList.add('kn-c4-drill')
    }
  },
  { flush: 'post', immediate: true },
)

// ── edits ─────────────────────────────────────────────────────────────────
/** Apply an edit to the text and send it up; a refusal or a broken result is said, not thrown. */
function commit(edit: (source: string) => string): boolean {
  try {
    const next = edit(props.source)
    if (next !== props.source) emit('update:source', next)
    return true
  } catch (e) {
    if (!(e instanceof C4EditError || e instanceof C4SyntaxError)) throw e
    toast.error(t('c4.studio.refused'), { description: e.message })
    return false
  }
}

function patchElement(patch: C4ElementPatch) {
  const el = selectedNode.value
  if (el) commit((s) => updateElement(s, el.id, patch))
}

function patchRelationship(patch: { description?: string; technology?: string }) {
  const s = selection.value
  if (s && 'rel' in s) commit((src) => updateRelationship(src, s.rel, patch))
}

function removeSelection() {
  const s = selection.value
  if (!s) return
  const done = 'node' in s ? commit((src) => deleteElement(src, s.node)) : commit((src) => deleteRelationship(src, s.rel))
  if (!done) return
  selection.value = null
  toast(t('c4.studio.deleted'), { action: { label: t('c4.studio.undo'), onClick: () => emit('undo') } })
}

const NEW_NAME: Record<C4Kind, () => string> = {
  person: () => t('c4.studio.new.person'),
  softwareSystem: () => t('c4.studio.new.softwareSystem'),
  container: () => t('c4.studio.new.container'),
  component: () => t('c4.studio.new.component'),
}
const KIND_TEXT: Record<C4Kind, () => string> = {
  person: () => t('c4.studio.kind.person'),
  softwareSystem: () => t('c4.studio.kind.softwareSystem'),
  container: () => t('c4.studio.kind.container'),
  component: () => t('c4.studio.kind.component'),
}
const KIND_ICON = { person: User, softwareSystem: Boxes, container: Box, component: ComponentIcon } as const
const palette = computed(() => (view.value ? paletteFor(view.value.type) : []))

const nameField = ref<InstanceType<typeof Input> | null>(null)
function add(kind: C4Kind, at: C4Point) {
  let id = ''
  const ok = commit((s) => {
    const out = addElement(s, vi.value, kind, NEW_NAME[kind](), byIdNow(), at)
    id = out.id
    return out.source
  })
  if (!ok) return
  selection.value = { node: id }
  // The new element's name is the first thing anyone changes.
  void nextTick(() => (nameField.value?.$el as HTMLInputElement | undefined)?.select?.())
}

/** A click on the palette: beside everything already drawn, top-aligned, so nothing is covered. */
function freeSpot(): C4Point {
  const points = [...positions.value.values()]
  if (!points.length) return { x: 0, y: 0 }
  return { x: Math.max(...points.map((p) => p.x)) + NODE_W + 90, y: Math.min(...points.map((p) => p.y)) }
}

function onPaletteDrag(event: DragEvent, kind: C4Kind) {
  event.dataTransfer?.setData('application/x-kn-c4', kind)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

function onDrop(event: DragEvent) {
  const kind = event.dataTransfer?.getData('application/x-kn-c4') as C4Kind | ''
  if (!kind || !palette.value.includes(kind)) return
  event.preventDefault()
  const p = toDiagram(event.clientX, event.clientY)
  add(kind, { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) })
}

function openDetail(el: C4Element) {
  const existing = detailViewOf(model.value!, el)
  if (existing) {
    goToView(model.value!.views.indexOf(existing))
    return
  }
  let index = -1
  if (
    commit((s) => {
      const out = addDetailView(s, el.id)
      index = out.viewIndex
      return out.source
    })
  ) {
    void nextTick(() => goToView(index))
  }
}

function goToView(index: number) {
  vi.value = index
  selection.value = null
  void nextTick(fit)
}

// ── canvas: pan, zoom, drag, connect ──────────────────────────────────────
const stage = ref<HTMLElement | null>(null)
const { width: stageW, height: stageH } = useElementSize(stage)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const percent = computed(() => Math.round(scale.value * 100))

function toDiagram(clientX: number, clientY: number): C4Point {
  const box = stage.value!.getBoundingClientRect()
  return { x: (clientX - box.left - tx.value) / scale.value, y: (clientY - box.top - ty.value) / scale.value }
}

function zoomTo(next: number, clientX?: number, clientY?: number) {
  const box = stage.value?.getBoundingClientRect()
  if (!box) return
  next = Math.min(3, Math.max(0.2, next))
  const cx = (clientX ?? box.left + box.width / 2) - box.left
  const cy = (clientY ?? box.top + box.height / 2) - box.top
  tx.value = cx - ((cx - tx.value) * next) / scale.value
  ty.value = cy - ((cy - ty.value) * next) / scale.value
  scale.value = next
}

/** Everything in view, no larger than 1:1. */
function fit() {
  const points = [...positions.value.values()]
  if (!points.length || !stageW.value) return
  const x0 = Math.min(...points.map((p) => p.x)) - 40
  const y0 = Math.min(...points.map((p) => p.y)) - 60
  const x1 = Math.max(...points.map((p) => p.x + NODE_W)) + 40
  const y1 = Math.max(...points.map((p) => p.y + NODE_H)) + 40
  scale.value = Math.min(1, stageW.value / (x1 - x0), stageH.value / (y1 - y0))
  tx.value = (stageW.value - (x1 - x0) * scale.value) / 2 - x0 * scale.value
  ty.value = (stageH.value - (y1 - y0) * scale.value) / 2 - y0 * scale.value
}
onMounted(() => void nextTick(fit))
watch(stageW, (w, before) => !before && w && fit())

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const unit = event.deltaMode === 1 ? 16 : 1
  if (event.ctrlKey || event.metaKey) {
    const dy = Math.max(-25, Math.min(25, event.deltaY * unit))
    zoomTo(scale.value * Math.exp(-dy / 100), event.clientX, event.clientY)
  } else {
    tx.value -= event.deltaX * unit
    ty.value -= event.deltaY * unit
  }
}

type Gesture =
  | { kind: 'pan'; x: number; y: number; tx: number; ty: number }
  | { kind: 'move'; id: string; from: C4Point; grab: C4Point; moved: boolean }
  | { kind: 'connect'; from: C4Element }
let gesture: Gesture | null = null
const wire = ref<{ from: C4Point; to: C4Point } | null>(null)

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || tab.value !== 'diagram') return
  const target = event.target as Element
  const handle = target.closest<SVGElement>('[data-c4-handle]')
  const hit = nodeAt(target)
  const el = hit ? drawn.value.nodes[hit.index] : null
  if (handle && el && props.editable) {
    const at = positions.value.get(el)!
    gesture = { kind: 'connect', from: el }
    wire.value = { from: { x: at.x + NODE_W, y: at.y + NODE_H / 2 }, to: toDiagram(event.clientX, event.clientY) }
    return
  }
  if (el) {
    selection.value = { node: el.id }
    if (props.editable) gesture = { kind: 'move', id: el.id, from: positions.value.get(el)!, grab: toDiagram(event.clientX, event.clientY), moved: false }
    return
  }
  const rel = target.closest<SVGGElement>('[data-c4-rel]')
  if (rel) {
    selection.value = { rel: Number(rel.dataset.c4Rel) }
    return
  }
  selection.value = null
  gesture = { kind: 'pan', x: event.clientX, y: event.clientY, tx: tx.value, ty: ty.value }
}

// The window follows a gesture, not the stage: capturing the pointer would
// retarget the click and double-click that select and open an element.
useEventListener(window, 'pointermove', (event: PointerEvent) => onPointerMove(event))
useEventListener(window, 'pointerup', (event: PointerEvent) => onPointerUp(event))
useEventListener(window, 'pointercancel', (event: PointerEvent) => onPointerUp(event))

function onPointerMove(event: PointerEvent) {
  const g = gesture
  if (!g) return
  if (g.kind === 'pan') {
    tx.value = g.tx + event.clientX - g.x
    ty.value = g.ty + event.clientY - g.y
  } else if (g.kind === 'move') {
    const p = toDiagram(event.clientX, event.clientY)
    const dx = p.x - g.grab.x
    const dy = p.y - g.grab.y
    if (!g.moved && Math.hypot(dx, dy) < 3) return
    g.moved = true
    moving.value = { id: g.id, at: { x: Math.round(g.from.x + dx), y: Math.round(g.from.y + dy) } }
  } else if (wire.value) {
    wire.value = { ...wire.value, to: toDiagram(event.clientX, event.clientY) }
  }
}

function onPointerUp(event: PointerEvent) {
  const g = gesture
  gesture = null
  if (g?.kind === 'move' && g.moved && moving.value) {
    const placed = byIdNow()
    commit((s) => placeElements(s, vi.value, placed))
    moving.value = null
  } else if (g?.kind === 'connect') {
    wire.value = null
    const hit = nodeAt(document.elementFromPoint(event.clientX, event.clientY))
    const to = hit ? drawn.value.nodes[hit.index] : null
    if (to && to !== g.from) commit((s) => connectElements(s, g.from.id, to.id))
  }
}

function onDblClick(event: MouseEvent) {
  const hit = nodeAt(event.target)
  const el = hit && drawn.value.nodes[hit.index]
  if (el && detailViewOf(model.value!, el)) openDetail(el)
}

function onCanvasClick(event: MouseEvent) {
  // Exploring, one click opens the level below, as in the page.
  if (props.editable) return
  const hit = nodeAt(event.target)
  const el = hit && drawn.value.nodes[hit.index]
  if (el && detailViewOf(model.value!, el)) openDetail(el)
}

// ── keyboard ──────────────────────────────────────────────────────────────
const typing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]')

function onKeydown(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey
  if (props.editable && mod && event.key.toLowerCase() === 'z' && !typing(event.target)) {
    event.preventDefault()
    if (event.shiftKey) emit('redo')
    else emit('undo')
    return
  }
  if (typing(event.target)) return
  const el = selectedNode.value
  if (props.editable && (event.key === 'Delete' || event.key === 'Backspace') && selection.value) {
    event.preventDefault()
    removeSelection()
  } else if (props.editable && el && event.key.startsWith('Arrow')) {
    event.preventDefault()
    const step = event.shiftKey ? 50 : 10
    const at = positions.value.get(el)
    if (!at) return
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key] ?? [0, 0]
    commit((s) => placeElements(s, vi.value, { ...byIdNow(), [el.id]: { x: at.x + d[0], y: at.y + d[1] } }))
  } else if (event.key === 'Enter' && el && detailViewOf(model.value!, el)) {
    event.preventDefault()
    openDetail(el)
  }
}

/** Focus on an element selects it, so the keyboard reaches everything the pointer does. */
function onFocusIn(event: FocusEvent) {
  const hit = nodeAt(event.target)
  const el = hit && drawn.value.nodes[hit.index]
  if (el) selection.value = { node: el.id }
}

function onEscape(event: Event) {
  // Esc clears a selection first; with nothing selected it closes.
  if (selection.value || gesture) {
    event.preventDefault()
    selection.value = null
    gesture = null
    wire.value = null
    moving.value = null
  }
}

// ── the Source tab ────────────────────────────────────────────────────────
const sendSource = useDebounceFn((value: string) => emit('update:source', value), 400)

const selectedDetail = computed(() => (selectedNode.value && model.value ? detailViewOf(model.value, selectedNode.value) : undefined))
const canGoDeeper = computed(() => selectedNode.value?.kind === 'softwareSystem' || selectedNode.value?.kind === 'container')
</script>

<template>
  <Dialog :open="true" @update:open="(open) => !open && emit('close')">
    <DialogContent
      hide-close
      class="top-0 left-0 grid h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-0 bg-background p-0 text-foreground shadow-none overflow-hidden"
      @keydown="onKeydown"
      @escape-key-down="onEscape"
    >
      <header class="flex min-w-0 flex-wrap items-center gap-2 border-b px-3 py-2 lg:h-14 lg:flex-nowrap lg:px-5">
        <DialogTitle class="font-display text-base font-semibold tracking-tight">
          {{ editable ? t('c4.studio.titleEdit') : t('c4.studio.title') }}
        </DialogTitle>
        <DialogDescription class="sr-only">{{ editable ? t('c4.studio.hintEdit') : t('c4.studio.hint') }}</DialogDescription>
        <label class="relative flex min-w-0 items-center">
          <span class="sr-only">{{ t('c4.studio.view') }}</span>
          <select
            class="h-9 max-w-[16rem] truncate rounded-md border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring"
            :value="vi"
            @change="goToView(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="(v, i) in model?.views ?? []" :key="v.key" :value="i">{{ title(v) }}</option>
          </select>
        </label>
        <div class="kn-c4-tabs" role="tablist" :aria-label="t('c4.tabs')">
          <button type="button" role="tab" :aria-selected="tab === 'diagram'" @click="tab = 'diagram'">{{ t('c4.tab.diagram') }}</button>
          <button type="button" role="tab" :aria-selected="tab === 'source'" @click="tab = 'source'">{{ t('c4.tab.source') }}</button>
        </div>
        <span class="flex-1" />
        <template v-if="tab === 'diagram'">
          <Button v-if="editable && view?.layout" variant="ghost" size="sm" @click="commit((s) => clearLayout(s, vi))">
            <RotateCcw class="size-4" aria-hidden="true" /> {{ t('c4.studio.autoLayout') }}
          </Button>
          <button type="button" :class="headerButton" :aria-label="t('c4.zoomOut')" :title="t('c4.zoomOut')" @click="zoomTo(scale / 1.25)">
            <ZoomOut class="size-4" aria-hidden="true" />
          </button>
          <span class="min-w-12 text-center font-mono text-xs tabular-nums text-muted-foreground" aria-live="polite">{{ percent }}%</span>
          <button type="button" :class="headerButton" :aria-label="t('c4.zoomIn')" :title="t('c4.zoomIn')" @click="zoomTo(scale * 1.25)">
            <ZoomIn class="size-4" aria-hidden="true" />
          </button>
          <button type="button" :class="headerButton" :aria-label="t('c4.studio.fit')" :title="t('c4.studio.fit')" @click="fit">
            <Maximize class="size-4" aria-hidden="true" />
          </button>
        </template>
        <button type="button" :class="headerButton" :aria-label="t('c4.studio.close')" :title="t('c4.studio.close')" @click="emit('close')">
          <X class="size-4" aria-hidden="true" />
        </button>
      </header>

      <div
        class="grid min-h-0"
        :class="editable && tab === 'diagram' ? 'grid-rows-[auto_minmax(0,1fr)_auto] lg:grid-cols-[12rem_minmax(0,1fr)_18rem] lg:grid-rows-1' : ''"
      >
        <!-- Palette ------------------------------------------------------------ -->
        <nav
          v-if="editable && tab === 'diagram'"
          :aria-label="t('c4.studio.palette')"
          class="flex gap-1 overflow-x-auto border-b bg-sidebar p-2 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-3"
        >
          <p class="hidden px-1 pb-1 text-xs font-medium text-muted-foreground lg:block">{{ t('c4.studio.add') }}</p>
          <button
            v-for="kind in palette"
            :key="kind"
            type="button"
            draggable="true"
            class="kn-c4-palette-item"
            :data-kind="kind"
            :title="t('c4.studio.addHint')"
            @click="add(kind, freeSpot()); nextTick(fit)"
            @dragstart="onPaletteDrag($event, kind)"
          >
            <component :is="KIND_ICON[kind]" class="size-4 shrink-0" aria-hidden="true" />
            <span>{{ KIND_TEXT[kind]() }}</span>
          </button>
        </nav>

        <!-- Canvas ------------------------------------------------------------- -->
        <div
          v-show="tab === 'diagram'"
          ref="stage"
          class="kn-c4-studio-stage"
          :style="{ backgroundSize: `${20 * scale}px ${20 * scale}px`, backgroundPosition: `${tx}px ${ty}px` }"
          role="group"
          :aria-label="view ? title(view) : undefined"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @dblclick="onDblClick"
          @click="onCanvasClick"
          @focusin="onFocusIn"
          @dragover.prevent
          @drop="onDrop"
        >
          <div class="absolute top-0 left-0 origin-top-left" :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }">
            <!-- eslint-disable-next-line vue/no-v-html -- built by renderC4Svg from parsed text, then sanitized -->
            <div ref="canvas" class="kn-c4-studio-canvas" :data-editable="editable || undefined" v-html="drawn.html" />
            <svg v-if="wire" class="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden="true">
              <line :x1="wire.from.x" :y1="wire.from.y" :x2="wire.to.x" :y2="wire.to.y" stroke="var(--primary)" stroke-width="2" stroke-dasharray="6 4" />
            </svg>
          </div>
          <p v-if="problem" class="absolute right-3 bottom-3 left-3 rounded-md border border-destructive bg-background px-3 py-2 text-sm text-destructive" role="alert">
            {{ problem }}
          </p>
        </div>

        <!-- Source ------------------------------------------------------------- -->
        <div v-if="tab === 'source'" class="flex min-h-0 flex-col p-3 lg:p-5">
          <Textarea
            v-if="editable"
            class="min-h-0 flex-1 resize-none font-mono text-sm"
            spellcheck="false"
            :aria-label="t('c4.tab.source')"
            :model-value="source"
            @update:model-value="sendSource(String($event))"
          />
          <pre v-else class="min-h-0 flex-1 overflow-auto rounded-md border p-4 text-sm" tabindex="0"><code>{{ source }}</code></pre>
          <p v-if="problem" class="pt-2 text-sm text-destructive" role="alert">{{ problem }}</p>
        </div>

        <!-- Inspector ---------------------------------------------------------- -->
        <aside
          v-if="editable && tab === 'diagram'"
          :aria-label="t('c4.studio.inspector')"
          class="max-h-[45dvh] overflow-y-auto border-t p-4 lg:max-h-none lg:border-t-0 lg:border-l"
        >
          <form v-if="selectedNode" :key="selectedNode.id" class="grid gap-3" @submit.prevent>
            <p class="text-xs font-medium text-muted-foreground">{{ KIND_TEXT[selectedNode.kind]() }}</p>
            <div class="grid gap-1.5">
              <Label :for="`c4-name-${selectedNode.id}`">{{ t('c4.studio.name') }}</Label>
              <Input
                :id="`c4-name-${selectedNode.id}`"
                ref="nameField"
                :model-value="selectedNode.name"
                @change="patchElement({ name: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <div class="grid gap-1.5">
              <Label :for="`c4-desc-${selectedNode.id}`">{{ t('c4.studio.description') }}</Label>
              <Textarea
                :id="`c4-desc-${selectedNode.id}`"
                rows="3"
                :model-value="selectedNode.description"
                @change="patchElement({ description: ($event.target as HTMLTextAreaElement).value })"
              />
            </div>
            <div v-if="selectedNode.kind === 'container' || selectedNode.kind === 'component'" class="grid gap-1.5">
              <Label :for="`c4-tech-${selectedNode.id}`">{{ t('c4.studio.technology') }}</Label>
              <Input
                :id="`c4-tech-${selectedNode.id}`"
                :model-value="selectedNode.technology"
                :placeholder="t('c4.studio.technologyHint')"
                @change="patchElement({ technology: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                :model-value="selectedNode.tags.some((x) => x.toLowerCase() === 'external')"
                @update:model-value="patchElement({ external: $event === true })"
              />
              {{ t('c4.studio.external') }}
            </label>
            <label v-if="selectedNode.kind === 'container' || selectedNode.kind === 'component'" class="flex items-center gap-2 text-sm">
              <Checkbox
                :model-value="selectedNode.tags.some((x) => x.toLowerCase() === 'database')"
                @update:model-value="patchElement({ database: $event === true })"
              />
              {{ t('c4.studio.database') }}
            </label>
            <div class="flex flex-wrap gap-2 pt-1">
              <Button v-if="canGoDeeper" type="button" variant="outline" size="sm" @click="openDetail(selectedNode)">
                <ArrowDownToLine class="size-4" aria-hidden="true" />
                {{ selectedDetail ? t('c4.studio.openLevel', { view: title(selectedDetail) }) : selectedNode.kind === 'softwareSystem' ? t('c4.studio.addContainers') : t('c4.studio.addComponents') }}
              </Button>
              <Button type="button" variant="ghost" size="sm" class="text-destructive" @click="removeSelection">
                <Trash2 class="size-4" aria-hidden="true" /> {{ t('c4.studio.delete') }}
              </Button>
            </div>
          </form>

          <form v-else-if="selectedRel" :key="`rel-${selection && 'rel' in selection ? selection.rel : ''}`" class="grid gap-3" @submit.prevent>
            <p class="text-xs font-medium text-muted-foreground">{{ t('c4.studio.relationship') }}</p>
            <p class="text-sm">{{ selectedRel.source.name }} → {{ selectedRel.destination.name }}</p>
            <div class="grid gap-1.5">
              <Label for="c4-rel-desc">{{ t('c4.studio.description') }}</Label>
              <Input
                id="c4-rel-desc"
                :model-value="selectedRel.description"
                :placeholder="t('c4.studio.relationshipHint')"
                @change="patchRelationship({ description: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="c4-rel-tech">{{ t('c4.studio.technology') }}</Label>
              <Input
                id="c4-rel-tech"
                :model-value="selectedRel.technology"
                :placeholder="t('c4.studio.protocolHint')"
                @change="patchRelationship({ technology: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <div>
              <Button type="button" variant="ghost" size="sm" class="text-destructive" @click="removeSelection">
                <Trash2 class="size-4" aria-hidden="true" /> {{ t('c4.studio.delete') }}
              </Button>
            </div>
          </form>

          <div v-else class="grid gap-2 text-sm text-muted-foreground">
            <p>{{ t('c4.studio.emptyAdd') }}</p>
            <p>{{ t('c4.studio.emptyConnect') }}</p>
            <p>{{ t('c4.studio.emptyKeys') }}</p>
          </div>
        </aside>
      </div>
    </DialogContent>
  </Dialog>
</template>
