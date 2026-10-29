<script setup lang="ts">
/**
 * A page's images, given the whole screen (#467).
 *
 * The gallery gesture of GraphLightbox, taken further: the page goes away
 * entirely and the image sits on a dark stage, whatever the theme, because a
 * screenshot reads against neither the paper nor its own edges. The stage takes
 * the `.dark` tokens rather than colours of its own. Focus trapping, scroll
 * locking, Escape and focus return are the Dialog's.
 *
 * It owns no markup in the page: it listens on the read surface's `root` for a
 * click or Enter on an image the surface marked (lib/image-gallery) and builds
 * the gallery from the DOM at that moment, so every surface shares one
 * definition of which images open and in what order.
 *
 * Zoom is a transform over the fitted image: scale 1 is "fit", the natural
 * size is `naturalWidth / offsetWidth`. A click toggles between the two at the
 * clicked point, one pointer pans, two pinch (./lightbox).
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEventListener } from '@vueuse/core'
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog'
import { galleryFrom, zoomableAt, type GalleryImage } from '@/shared/utils/image-gallery'
import { headerButton, navButton, usePanZoom } from './lightbox'

const props = defineProps<{ root: HTMLElement | null }>()

const { t } = useI18n()

const open = ref(false)
const images = ref<GalleryImage[]>([])
const index = ref(0)
const current = computed(() => images.value[index.value])

function show(img: HTMLImageElement) {
  if (!props.root) return
  const gallery = galleryFrom(props.root, img)
  images.value = gallery.images
  go(gallery.index)
  open.value = true
}

useEventListener(() => props.root, ['click', 'keydown'], (event: MouseEvent | KeyboardEvent) => {
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
  const img = zoomableAt(event.target)
  if (!img) return
  event.preventDefault()
  show(img)
})

// ── navigation ────────────────────────────────────────────────────────────
function go(next: number) {
  if (next < 0 || next >= images.value.length) return
  index.value = next
  reset()
  canZoom.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') go(index.value - 1)
  else if (event.key === 'ArrowRight') go(index.value + 1)
  else return
  event.preventDefault()
}

// ── zoom & pan ────────────────────────────────────────────────────────────
const stage = ref<HTMLElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
/** The image is larger than it is drawn at fit, so 1:1 shows more. */
const canZoom = ref(false)

const naturalScale = () => (image.value ? image.value.naturalWidth / image.value.offsetWidth : 1)

const { scale, tx, ty, dragging, zoomed, reset, zoomTo, wasDrag, onPointerDown, onPointerMove, onPointerUp } = usePanZoom(
  stage,
  () => ({ w: image.value?.offsetWidth ?? 0, h: image.value?.offsetHeight ?? 0 }),
  () => Math.max(naturalScale(), 2),
)

function onImageLoad() {
  canZoom.value = naturalScale() > 1.05
}

function toggleZoom(cx?: number, cy?: number) {
  if (!canZoom.value) return
  zoomTo(zoomed.value ? 1 : naturalScale(), cx, cy)
}

function onStageClick(event: MouseEvent) {
  if (wasDrag()) return
  if (event.target === image.value) toggleZoom(event.clientX, event.clientY)
  // The empty stage is the backdrop: a click there leaves, like outside any dialog.
  else if (event.target === stage.value) open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      hide-close
      class="dark top-0 left-0 grid h-dvh w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 rounded-none border-0 bg-background p-0 text-foreground shadow-none"
      @keydown="onKeydown"
    >
      <div class="flex min-w-0 items-center gap-2 px-3 py-2 sm:px-4">
        <DialogTitle class="sr-only">{{ t('imageViewer.title') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t('imageViewer.hint') }}</DialogDescription>
        <p
          v-if="images.length > 1"
          class="flex-1 font-mono text-xs tabular-nums text-muted-foreground"
          :aria-label="t('imageViewer.position', { n: index + 1, total: images.length })"
          aria-live="polite"
        >
          {{ index + 1 }} / {{ images.length }}
        </p>
        <span v-else class="flex-1" />
        <button
          type="button"
          :class="headerButton"
          :disabled="!canZoom"
          :aria-pressed="zoomed"
          :aria-label="zoomed ? t('imageViewer.fit') : t('imageViewer.actualSize')"
          :title="zoomed ? t('imageViewer.fit') : t('imageViewer.actualSize')"
          @click="toggleZoom()"
        >
          <ZoomOut v-if="zoomed" class="size-4" />
          <ZoomIn v-else class="size-4" />
        </button>
        <kbd class="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground sm:inline-block">
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
        @click="onStageClick"
      >
        <img
          v-if="current"
          ref="image"
          :key="current.src + index"
          :src="current.src"
          :alt="current.alt"
          draggable="false"
          class="absolute inset-0 m-auto max-h-full max-w-[calc(100%-1.5rem)] rounded-sm sm:max-w-[calc(100%-8rem)] motion-reduce:transition-none"
          :class="[
            dragging ? '' : 'transition-transform duration-200 ease-[var(--snap-ease)]',
            canZoom ? (zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-zoom-out') : 'cursor-zoom-in') : '',
          ]"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          @load="onImageLoad"
        />
        <template v-if="images.length > 1">
          <button
            type="button"
            :class="[navButton, 'left-2 sm:left-4']"
            :disabled="index === 0"
            :aria-label="t('imageViewer.previous')"
            @click.stop="go(index - 1)"
          >
            <ChevronLeft class="size-5" />
          </button>
          <button
            type="button"
            :class="[navButton, 'right-2 sm:right-4']"
            :disabled="index === images.length - 1"
            :aria-label="t('imageViewer.next')"
            @click.stop="go(index + 1)"
          >
            <ChevronRight class="size-5" />
          </button>
        </template>
      </div>

      <p class="min-h-10 px-4 py-2.5 text-center text-sm text-muted-foreground text-pretty">
        {{ current?.alt }}
      </p>
    </DialogContent>
  </Dialog>
</template>
