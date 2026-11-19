<script setup lang="ts">
/**
 * A C4 model (#1244, docs/features/85), in two tabs: the drawing and its
 * Structurizr source. The drawing is one view at a time (model/c4-draw): an
 * element that has a view of its own glows and opens it — the drawing zooms
 * into the element and the next level grows out of it — and the trail above
 * leads back out.
 *
 * Pan and zoom happen in place (the lightbox's model, @knowledge/ui): Ctrl or
 * a pinch and the wheel, the buttons, and a drag once zoomed. A plain wheel
 * still scrolls the page. The last button opens the model full screen
 * (C4Studio): to explore it, or, in the editor, to build it.
 *
 * The Source tab shows the text, or what the host puts in the `source` slot —
 * the editor's own code block, so that it stays where the editor wrote it.
 */
import { computed, defineAsyncComponent, nextTick, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { watchDebounced } from '@vueuse/core'
import { Maximize2, PenTool, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { headerButton, usePanZoom } from '@knowledge/ui/lightbox'
import { detailViewOf, parseStructurizr, type C4Element, type C4Model, type C4View } from '@/core/markdown/structurizr'
import { useTheme } from '@/shared/utils/theme'
import { drawC4View, nodeAt } from '../model/c4-draw'
import { useC4Levels } from '../model/use-c4-levels'

// Full screen only: its canvas and editing code load on first open. Not from ./lazy, which loads this file.
const LazyC4Studio = defineAsyncComponent(() => import('./C4Studio.vue'))

const props = defineProps<{
  source: string
  /** Model output (MarkdownView's `untrusted`): the SVG loses remote loads too. */
  untrusted?: boolean
  /** In an editor: the full-screen button builds rather than explores. */
  editable?: boolean
  /**
   * false: the host opens the full-screen view itself, on `open` — the editor,
   * where ProseMirror may rebuild this view at any moment and a dialog must not
   * go with it. Anywhere else the view opens its own, to explore.
   */
  hostsStudio?: boolean
}>()
const emit = defineEmits<{ open: [viewIndex: number] }>()
const tab = defineModel<'diagram' | 'source'>('tab', { default: 'diagram' })
const fullscreen = ref(false)
function openFullscreen() {
  if (props.hostsStudio === false) emit('open', viewIndex.value)
  else fullscreen.value = true
}

const { t } = useI18n()
const theme = useTheme()
const title = useC4Levels()
const uid = useId()

const model = shallowRef<C4Model | null>(null)
const error = ref('')
/** The views from the first one down to the one on screen. */
const trail = shallowRef<C4View[]>([])
const svg = ref('')
const nodes = shallowRef<C4Element[]>([])
const status = ref('')
const viewIndex = computed(() => (model.value && trail.value.length ? model.value.views.indexOf(trail.value.at(-1)!) : 0))

// ── drawing ───────────────────────────────────────────────────────────────
const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLElement | null>(null)

/** Mark the elements that have a view of their own: they glow, take focus and open it. */
function decorate() {
  for (const g of canvas.value?.querySelectorAll<SVGGElement>('g[data-c4-node], g.node') ?? []) {
    const element = nodes.value[nodeAt(g)?.index ?? -1]
    const detail = element && detailViewOf(model.value!, element)
    if (!detail || detail === trail.value.at(-1)) continue
    g.classList.add('kn-c4-drill')
    g.setAttribute('tabindex', '0')
    g.setAttribute('role', 'button')
    g.setAttribute('aria-label', t('c4.open', { name: element.name, view: title(detail) }))
  }
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Show the last view of `next`. The new drawing is ready before anything
 * moves, so the zoom never waits on mermaid. In: the old view grows from the
 * element clicked and fades, the new one settles in from smaller. Out: the
 * reverse.
 */
async function show(next: C4View[], { from, move = true }: { from?: Element; move?: boolean } = {}) {
  let drawn: Awaited<ReturnType<typeof drawC4View>>
  try {
    drawn = await drawC4View(model.value!, next.at(-1)!, { isDark: theme.isDark.value, untrusted: props.untrusted })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
  const el = canvas.value
  const animate = move && !!el && !!svg.value && !reducedMotion()
  const deeper = next.length > trail.value.length
  let leaving: Animation | null = null
  if (animate) {
    const origin = from ? originIn(el, from) : 'center'
    leaving = el.animate(
      [
        { transform: 'scale(1)', opacity: 1, transformOrigin: origin },
        { transform: deeper ? 'scale(2.4)' : 'scale(0.6)', opacity: 0, transformOrigin: origin },
      ],
      { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    )
    await leaving.finished.catch(() => {})
  }
  svg.value = drawn.html
  nodes.value = drawn.nodes
  trail.value = next
  error.value = ''
  reset()
  await nextTick()
  decorate()
  leaving?.cancel()
  if (animate) {
    el.animate(
      [{ transform: deeper ? 'scale(0.82)' : 'scale(1.25)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    )
  }
  if (move) status.value = t('c4.showing', { view: title(next.at(-1)!) })
}

/** Where `node`'s centre sits inside `box`, as a transform-origin. */
function originIn(box: Element, node: Element): string {
  const b = box.getBoundingClientRect()
  const n = node.getBoundingClientRect()
  return `${n.left + n.width / 2 - b.left}px ${n.top + n.height / 2 - b.top}px`
}

/**
 * (Re)read the source. A source that no longer parses — an author mid-edit —
 * keeps the last good drawing and says what is wrong under it. The trail is
 * kept while its views still exist (a change made in the builder), else the
 * drawing starts again from the first view.
 */
function load() {
  let next: C4Model
  try {
    next = parseStructurizr(props.source)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
  const kept = trail.value.map((v) => next.views.find((n) => n.key === v.key))
  model.value = next
  void show(kept.length && kept.every(Boolean) ? (kept as C4View[]) : [next.views[0]], { move: false })
}

onMounted(load)
// Typing in the editor's code block changes the source on every key; the drawing follows after a pause.
watchDebounced(() => props.source, load, { debounce: 350 })
// Mermaid bakes the theme's colours into the SVG.
watch(theme.isDark, () => trail.value.length && void show(trail.value, { move: false }))

// ── zoom in on an element ─────────────────────────────────────────────────
function drillFrom(target: EventTarget | null) {
  const g = target instanceof Element ? target.closest<SVGGElement>('.kn-c4-drill') : null
  const element = g && nodes.value[nodeAt(g)?.index ?? -1]
  const detail = element && detailViewOf(model.value!, element)
  if (!g || !detail) return false
  void show([...trail.value, detail], { from: g }).then(() => stage.value?.focus({ preventScroll: true }))
  return true
}

function onClick(event: MouseEvent) {
  if (!wasDrag()) drillFrom(event.target)
}

function onKeydown(event: KeyboardEvent) {
  if ((event.key === 'Enter' || event.key === ' ') && drillFrom(event.target)) event.preventDefault()
}

function goTo(index: number) {
  void show(trail.value.slice(0, index + 1)).then(() => stage.value?.focus({ preventScroll: true }))
}

// ── tabs ──────────────────────────────────────────────────────────────────
const TABS = ['diagram', 'source'] as const
function onTabKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  tab.value = tab.value === 'diagram' ? 'source' : 'diagram'
  void nextTick(() => document.getElementById(`${uid}-tab-${tab.value}`)?.focus())
}

// ── pan & zoom ────────────────────────────────────────────────────────────
const MAX = 4
const STEP = 1.25
const { scale, tx, ty, dragging, zoomed, reset, zoomTo, wasDrag, onPointerDown, onPointerMove, onPointerUp } = usePanZoom(
  stage,
  () => ({ w: canvas.value?.offsetWidth ?? 0, h: canvas.value?.offsetHeight ?? 0 }),
  () => MAX,
)
const percent = computed(() => Math.round(scale.value * 100))

function onWheel(event: WheelEvent) {
  // A plain wheel scrolls the page past the diagram; Ctrl (or a trackpad pinch) zooms it.
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const dy = Math.max(-25, Math.min(25, event.deltaY * (event.deltaMode === 1 ? 16 : 1)))
  zoomTo(scale.value * Math.exp(-dy / 100), event.clientX, event.clientY)
}
</script>

<template>
  <figure class="kn-c4">
    <!-- The chrome is never page text: inside the editor, a click on it must not place a caret. -->
    <div class="kn-c4-bar" contenteditable="false">
      <div class="kn-c4-tabs" role="tablist" :aria-label="t('c4.tabs')">
        <button
          v-for="name in TABS"
          :id="`${uid}-tab-${name}`"
          :key="name"
          type="button"
          role="tab"
          :aria-selected="tab === name"
          :aria-controls="`${uid}-panel-${name}`"
          :tabindex="tab === name ? 0 : -1"
          @click="tab = name"
          @keydown="onTabKey"
        >
          {{ name === 'diagram' ? t('c4.tab.diagram') : t('c4.tab.source') }}
        </button>
      </div>
      <!-- Spans, not an <ol>: this sits inside the page's prose, whose list styles would number and space it. -->
      <nav v-show="tab === 'diagram' && svg" class="kn-c4-trail" :aria-label="t('c4.trail')">
        <template v-for="(view, i) in trail" :key="view.key">
          <button v-if="i < trail.length - 1" type="button" @click="goTo(i)">{{ title(view) }}</button>
          <span v-else aria-current="location">{{ title(view) }}</span>
        </template>
      </nav>
      <div class="kn-c4-tools" role="group" :aria-label="t('c4.zoom')">
        <template v-if="tab === 'diagram' && svg">
          <button type="button" :class="headerButton" :disabled="scale <= 1" :aria-label="t('c4.zoomOut')" :title="t('c4.zoomOut')" @click="zoomTo(scale / STEP)">
            <ZoomOut class="size-4" aria-hidden="true" />
          </button>
          <button type="button" class="kn-c4-percent" :disabled="!zoomed" :aria-label="t('c4.fit', { percent })" :title="t('c4.fit', { percent })" @click="reset()">
            {{ percent }}%
          </button>
          <button type="button" :class="headerButton" :disabled="scale >= MAX" :aria-label="t('c4.zoomIn')" :title="t('c4.zoomIn')" @click="zoomTo(scale * STEP)">
            <ZoomIn class="size-4" aria-hidden="true" />
          </button>
        </template>
        <button
          v-if="model"
          type="button"
          :class="headerButton"
          :aria-label="editable ? t('c4.build') : t('c4.fullscreen')"
          :title="editable ? t('c4.build') : t('c4.fullscreen')"
          @click="openFullscreen"
        >
          <PenTool v-if="editable" class="size-4" aria-hidden="true" />
          <Maximize2 v-else class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-show="tab === 'diagram'" :id="`${uid}-panel-diagram`" role="tabpanel" :aria-labelledby="`${uid}-tab-diagram`" contenteditable="false">
      <p v-if="error && !svg" class="kn-c4-error kn-c4-empty">{{ error }}</p>
      <div
        v-show="svg"
        ref="stage"
        class="kn-c4-stage"
        tabindex="-1"
        :aria-label="trail.length ? title(trail[trail.length - 1]) : undefined"
        role="group"
        :data-zoomed="zoomed || undefined"
        :data-dragging="dragging || undefined"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <div class="kn-c4-pan" :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }">
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized in drawC4View -->
          <div ref="canvas" class="kn-c4-canvas" v-html="svg" @click="onClick" @keydown="onKeydown" />
        </div>
      </div>
      <p v-if="error && svg" class="kn-c4-error" role="alert">{{ error }}</p>
    </div>

    <div v-show="tab === 'source'" :id="`${uid}-panel-source`" role="tabpanel" class="kn-c4-source" :aria-labelledby="`${uid}-tab-source`">
      <slot name="source">
        <pre tabindex="0"><code>{{ source }}</code></pre>
      </slot>
    </div>

    <p class="sr-only" aria-live="polite" contenteditable="false">{{ status }}</p>
    <LazyC4Studio
      v-if="fullscreen && model && hostsStudio !== false"
      :source="source"
      :view-index="viewIndex"
      :untrusted="untrusted"
      @close="fullscreen = false"
    />
  </figure>
</template>
