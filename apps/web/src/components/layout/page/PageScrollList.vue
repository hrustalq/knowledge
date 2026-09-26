<script setup lang="ts" generic="T">
/**
 * A list that ends where the screen does, renders only what is on it, and asks
 * for the next page before the reader reaches the last row.
 *
 * The activity feed settled the shape — a virtualized window inside its own
 * scrollport, paging in on scroll with a button as the keyboard path — but it
 * sizes itself from a `calc(100vh - 15rem)` guess and assumes every row is one
 * line. This is that feed's logic for lists whose rows are not: a work item
 * wraps its labels, a run grows a warnings disclosure. So rows are measured
 * (TanStack's `measureElement`, the merge-request timeline's approach) and the
 * height is asked of the page rather than guessed.
 *
 * **The height.** The scrollport runs from wherever it starts down to the
 * bottom of `<main>`, less the column's own bottom padding — so the page itself
 * stops scrolling and the list scrolls instead. It is measured against the
 * scroller's content rather than the viewport, which keeps the answer right on
 * a page that is already scrolled, and re-measured whenever the page's column
 * or the window changes size: a header that wraps on a narrow window moves the
 * list down, and the list must give that space back. `minHeight` is the floor
 * on a short window, where filling "the rest" would leave three rows.
 *
 * **Paging.** The next page is requested once the window reaches the last
 * `prefetch` rows, not when the end is visible — waiting for the end is how a
 * reader ends up watching a spinner they scrolled to.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { Button } from '@/components/ui/button'

const props = withDefaults(
  defineProps<{
    items: readonly T[]
    itemKey: (item: T) => string
    /** First-paint guess only; every row is measured once it renders. */
    estimateSize?: number
    hasMore?: boolean
    loadingMore?: boolean
    /** Floor for the fitted height, in px. */
    minHeight?: number
    /** How many rows from the end the next page is asked for. */
    prefetch?: number
    label?: string
  }>(),
  { estimateSize: 64, hasMore: false, loadingMore: false, minHeight: 320, prefetch: 8, label: undefined },
)

const emit = defineEmits<{ 'load-more': [] }>()

defineSlots<{ default(props: { item: T; index: number }): unknown }>()

const { t } = useI18n()

const scrollEl = ref<HTMLElement | null>(null)
/** `null` until measured — SSR and the first client frame use the CSS fallback. */
const height = ref<number | null>(null)

function fit() {
  const el = scrollEl.value
  const main = el?.closest('main')
  if (!el || !main) return
  const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
  const column = main.firstElementChild
  const padding = column ? Number.parseFloat(getComputedStyle(column).paddingBottom) || 0 : 0
  const next = Math.max(props.minHeight, Math.floor(main.clientHeight - top - padding))
  // Sub-pixel churn would re-run the virtualizer on every observed frame.
  if (height.value === null || Math.abs(next - height.value) > 1) height.value = next
}

let observer: ResizeObserver | null = null

/**
 * Bound once the scroller exists, not on mount: the first paint of every caller
 * is a loading state, so on mount there is nothing to measure from yet.
 */
watch(
  scrollEl,
  (el) => {
    observer?.disconnect()
    observer = null
    const main = el?.closest('main')
    if (!el || !main) return
    fit()
    if (typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(() => fit())
    observer.observe(main)
    if (main.firstElementChild) observer.observe(main.firstElementChild)
  },
  { flush: 'post' },
)

onBeforeUnmount(() => observer?.disconnect())

const virtualizer = useVirtualizer(
  computed(() => {
    // Read through the ref here, not inside getScrollElement — see
    // DocumentsListPage: options that do not recompute when the scroller lands
    // leave the virtualizer attached to nothing.
    const scroller = scrollEl.value
    return {
      count: props.items.length,
      getScrollElement: () => scroller,
      estimateSize: () => props.estimateSize,
      overscan: 6,
      getItemKey: (index: number) => {
        const item = props.items[index]
        return item === undefined ? index : props.itemKey(item)
      },
    }
  }),
)

const rows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
/** Rows sit in normal flow inside one wrapper, so `divide-y` still draws between them. */
const offsetY = computed(() => rows.value[0]?.start ?? 0)

function measure(el: Element | { $el?: unknown } | null): void {
  if (el instanceof Element) virtualizer.value.measureElement(el)
}

watch(rows, (window) => {
  const last = window[window.length - 1]
  if (!last || !props.hasMore || props.loadingMore) return
  if (last.index >= props.items.length - props.prefetch) emit('load-more')
})
</script>

<template>
  <div
    ref="scrollEl"
    class="overflow-y-auto rounded-lg border"
    :class="height === null ? 'h-[60vh]' : ''"
    :style="height === null ? undefined : { height: `${height}px` }"
    role="region"
    :aria-label="label"
    tabindex="0"
  >
    <div class="relative w-full" :style="{ height: `${totalSize}px` }">
      <ul class="absolute inset-x-0 top-0 divide-y" :style="{ transform: `translateY(${offsetY}px)` }">
        <li v-for="row in rows" :key="String(row.key)" :ref="measure" :data-index="row.index">
          <slot v-if="items[row.index] !== undefined" :item="items[row.index]!" :index="row.index" />
        </li>
      </ul>
    </div>

    <!-- The keyboard path, and what a reader sees for the instant the next page
         is in flight. Scrolling asks on its own before anyone gets here. -->
    <div v-if="hasMore" class="flex justify-center border-t p-2">
      <Button size="sm" variant="ghost" :disabled="loadingMore" @click="emit('load-more')">
        {{ loadingMore ? t('common.loadingMore') : t('common.loadMore') }}
      </Button>
    </div>
  </div>
</template>
