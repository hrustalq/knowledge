<script setup lang="ts">
/**
 * A page's diagrams, given the whole screen (#476): mermaid of any kind and
 * whiteboard drawings, which the column shrinks until a wide one cannot be read.
 *
 * ImageLightbox's frame and gestures (./lightbox), with two differences:
 *
 * - The stage keeps the app's theme instead of going dark. Mermaid bakes the
 *   page theme's colours into its SVG and drawings inherit `--kn-draw-*`, so the
 *   copy only looks like the page against the page's own ground.
 * - It shows a copy of the SVG the page drew (lib/diagram-gallery), sized for
 *   real rather than transformed, so 400% is as sharp as 100%. Nothing is
 *   re-rendered and nothing is fetched.
 *
 * Zoomed, the diagram is grabbed: a drag (or the wheel) moves it, and a click
 * no longer resets the view.
 *
 * Like the image lightbox it owns no markup in the page: it listens on the read
 * surface's `root` for a click or Enter on a diagram the surface marked.
 */
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize, useEventListener, useMutationObserver } from '@vueuse/core'
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog'
import { DIAGRAM_ATTR, copyDiagram, diagramAt, diagramsIn, type DiagramCopy } from '@/shared/utils/diagram-gallery'
import { headerButton, navButton, usePanZoom } from './lightbox'

const props = defineProps<{ root: HTMLElement | null }>()

const { t } = useI18n()

const open = ref(false)
const total = ref(0)
const index = ref(0)
const diagram = shallowRef<DiagramCopy | null>(null)

function load(next: number): boolean {
  const list = props.root ? diagramsIn(props.root) : []
  const copy = list[next] ? copyDiagram(list[next]) : null
  if (!copy) return false
  diagram.value = copy
  index.value = next
  total.value = list.length
  return true
}

function go(next: number): boolean {
  if (!load(next)) return false
  reset()
  return true
}

useEventListener(() => props.root, ['click', 'keydown'], (event: MouseEvent | KeyboardEvent) => {
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
  const host = diagramAt(event.target)
  if (!host || !props.root) return
  event.preventDefault()
  if (go(diagramsIn(props.root).indexOf(host))) open.value = true
})

// The page re-draws its diagrams when the theme flips (mermaid bakes colours
// in), so follow the re-draw instead of showing the old theme. MarkdownView
// rebuilds all its markup and marks the diagrams last: until the count is back,
// the re-draw is still in progress.
useMutationObserver(
  () => (open.value ? props.root : null),
  () => {
    const list = props.root ? diagramsIn(props.root) : []
    const source = list.length === total.value ? list[index.value]?.querySelector('svg') : null
    if (source && source !== diagram.value?.source) load(index.value)
  },
  { childList: true, subtree: true, attributes: true, attributeFilter: [DIAGRAM_ATTR] },
)

const content = ref<HTMLElement | null>(null)
watch([diagram, content], ([d, el]) => el?.replaceChildren(...(d ? [d.svg] : [])), { flush: 'post' })

// ── zoom & pan ────────────────────────────────────────────────────────────
const stage = ref<HTMLElement | null>(null)
const { width: stageW, height: stageH } = useElementSize(stage)

/** The 1:1 size → fitted size factor. Clear of the side buttons on a wide screen. */
const fit = computed(() => {
  const d = diagram.value
  if (!d || !stageW.value || !stageH.value) return 1
  const padX = stageW.value < 640 ? 24 : 128
  // A small diagram grows to fill the screen, but to no more than twice its
  // size: past that it is a poster, and zoom is a button away.
  return Math.min((stageW.value - padX) / d.w, (stageH.value - 32) / d.h, 2)
})

// At least 4× fit, and at least 400% of the diagram's own size.
const maxScale = computed(() => Math.max(4, 4 / fit.value))

const { scale, tx, ty, dragging, zoomed, reset, clamp, zoomTo, wasDrag, onPointerDown, onPointerMove, onPointerUp } =
  usePanZoom(
    stage,
    () => ({ w: (diagram.value?.w ?? 0) * fit.value, h: (diagram.value?.h ?? 0) * fit.value }),
    () => maxScale.value,
  )
watch([stageW, stageH], clamp)

const percent = computed(() => Math.round(fit.value * scale.value * 100))
const STEP = 1.25

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const unit = event.deltaMode === 1 ? 16 : 1
  if (event.ctrlKey || event.metaKey) {
    // A trackpad pinch arrives as ctrl+wheel in small deltas; a mouse notch is
    // ~100, capped so that one notch is about one button press.
    const dy = Math.max(-25, Math.min(25, event.deltaY * unit))
    zoomTo(scale.value * Math.exp(-dy / 100), event.clientX, event.clientY)
  } else {
    tx.value -= event.deltaX * unit
    ty.value -= event.deltaY * unit
    clamp()
  }
}

function onStageClick(event: MouseEvent) {
  if (wasDrag()) return
  if (content.value?.contains(event.target as Node)) {
    // At fit a click zooms to the diagram's own size (or twice fit, for one that
    // fit enlarged). Zoomed, the diagram is grabbed and dragged, so a click that
    // barely moved must not throw the view back to fit: 0 and the % button do.
    if (!zoomed.value) zoomTo(Math.max(2, 1 / fit.value), event.clientX, event.clientY)
  }
  // The empty stage is the backdrop: a click there leaves, like outside any dialog.
  else if (event.target === stage.value) open.value = false
}

function onKeydown(event: KeyboardEvent) {
  // ⌘/Ctrl + and − stay the browser's page zoom.
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === 'ArrowLeft') go(index.value - 1)
  else if (event.key === 'ArrowRight') go(index.value + 1)
  else if (event.key === '+' || event.key === '=') zoomTo(scale.value * STEP)
  else if (event.key === '-' || event.key === '−' || event.key === '_') zoomTo(scale.value / STEP)
  else if (event.key === '0') zoomTo(1)
  else return
  event.preventDefault()
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      hide-close
      class="top-0 left-0 grid h-dvh w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-0 bg-background p-0 text-foreground shadow-none"
      @keydown="onKeydown"
    >
      <div class="flex min-w-0 items-center gap-1 px-3 py-2 sm:px-4">
        <DialogTitle class="sr-only">{{ t('diagramViewer.title') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t('diagramViewer.hint') }}</DialogDescription>
        <p
          v-if="total > 1"
          class="flex-1 font-mono text-xs tabular-nums text-muted-foreground"
          :aria-label="t('diagramViewer.position', { n: index + 1, total })"
          aria-live="polite"
        >
          {{ index + 1 }} / {{ total }}
        </p>
        <span v-else class="flex-1" />
        <button
          type="button"
          :class="headerButton"
          :disabled="!zoomed"
          :aria-label="t('diagramViewer.zoomOut')"
          :title="t('diagramViewer.zoomOut')"
          @click="zoomTo(scale / STEP)"
        >
          <ZoomOut class="size-4" />
        </button>
        <button
          type="button"
          class="h-8 min-w-14 rounded-md px-1.5 font-mono text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring"
          :aria-label="t('diagramViewer.fit', { percent })"
          :title="t('diagramViewer.fit', { percent })"
          @click="zoomTo(1)"
        >
          {{ percent }}%
        </button>
        <button
          type="button"
          :class="headerButton"
          :disabled="scale >= maxScale - 0.001"
          :aria-label="t('diagramViewer.zoomIn')"
          :title="t('diagramViewer.zoomIn')"
          @click="zoomTo(scale * STEP)"
        >
          <ZoomIn class="size-4" />
        </button>
        <kbd class="mx-1 hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground sm:inline-block">
          Esc
        </kbd>
        <DialogClose :class="headerButton" :aria-label="t('common.close')">
          <X class="size-4" />
        </DialogClose>
      </div>

      <div
        ref="stage"
        class="relative touch-none select-none overflow-hidden"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel="onWheel"
        @click="onStageClick"
      >
        <div
          v-if="diagram"
          ref="content"
          class="absolute top-1/2 left-1/2"
          :class="dragging ? 'cursor-grabbing' : zoomed ? 'cursor-grab' : 'cursor-zoom-in'"
          :style="{
            width: `${diagram.w * fit * scale}px`,
            height: `${diagram.h * fit * scale}px`,
            transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`,
          }"
        />
        <template v-if="total > 1">
          <button
            type="button"
            :class="[navButton, 'left-2 sm:left-4']"
            :disabled="index === 0"
            :aria-label="t('diagramViewer.previous')"
            @click.stop="go(index - 1)"
          >
            <ChevronLeft class="size-5" />
          </button>
          <button
            type="button"
            :class="[navButton, 'right-2 sm:right-4']"
            :disabled="index === total - 1"
            :aria-label="t('diagramViewer.next')"
            @click.stop="go(index + 1)"
          >
            <ChevronRight class="size-5" />
          </button>
        </template>
      </div>
    </DialogContent>
  </Dialog>
</template>
