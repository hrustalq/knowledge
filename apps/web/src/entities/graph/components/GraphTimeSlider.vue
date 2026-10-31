<script setup lang="ts">
/**
 * The graph's time axis (#81): a strip along the canvas bottom that reads
 * left → right like any timeline. The track carries the release tags as named
 * ticks and, above it, how much the knowledge base changed per stretch of
 * time — so the reader can see where to look before scrubbing. The thumb is a
 * needle, not a dot: round means a count or an identity here, and this is a
 * control.
 *
 * Everything right of the needle is dimmed. That is the one piece of
 * decoration it carries, and it is information: "after this point" is what the
 * graph above is no longer showing.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw } from 'lucide-vue-next'
import { formatDate, formatDayMonth } from '@/shared/utils/format'
import { atFraction, densityBars, fractionOf, nearestTag, stepPoint } from '../model/graph-time'
import type { GraphTime } from '../model/use-graph-time'

const props = defineProps<{ time: GraphTime }>()

const { t } = useI18n()

const BARS = 64
const track = ref<HTMLElement | null>(null)
const dragging = ref(false)

const span = computed(() => props.time.span.value)
const tags = computed(() => props.time.timeline.value?.tags ?? [])
const bars = computed(() =>
  span.value ? densityBars(props.time.timeline.value?.days ?? [], span.value.from, span.value.to, BARS) : [],
)
const at = computed(() => props.time.point.value?.at ?? null)
const thumb = computed(() => (span.value && at.value !== null ? fractionOf(at.value, span.value.from, span.value.to) : 1))
const selectedTag = computed(() => props.time.point.value?.tag ?? null)

/** Where a tag sits, 0..1. */
const tagFraction = (iso: string) => (span.value ? fractionOf(Date.parse(iso), span.value.from, span.value.to) : 0)
/**
 * Labels under the ends anchor inward, and an end label gives way to a tag
 * name that would otherwise sit on top of it — a tag made today lands exactly
 * on "Now".
 */
const crowdsStart = computed(() => tags.value.some((tag) => tagFraction(tag.at) < 0.1))
const crowdsEnd = computed(() => tags.value.some((tag) => tagFraction(tag.at) > 0.9))
const labelAnchor = (f: number) => (f > 0.92 ? '-translate-x-full' : f < 0.08 ? '' : '-translate-x-1/2')

const readout = computed(() => {
  if (at.value === null) return t('graph.time.nowHint')
  const date = formatDate(new Date(at.value))
  return selectedTag.value ? t('graph.time.asOfTag', { tag: selectedTag.value, date }) : t('graph.time.asOf', { date })
})

function pointAt(clientX: number): number | null {
  const el = track.value
  if (!el || !span.value) return null
  const box = el.getBoundingClientRect()
  return atFraction((clientX - box.left) / box.width, span.value.from, span.value.to)
}

/** Within 8px of a tag, the thumb is the tag — a drag can land on one by hand. */
function settle(next: number) {
  if (!span.value || !track.value) return
  const msPerPx = (span.value.to - span.value.from) / track.value.getBoundingClientRect().width
  const tag = nearestTag(next, tags.value, msPerPx * 8)
  if (tag) props.time.set({ at: Date.parse(tag.at), tag: tag.name })
  else if (next >= span.value.to - msPerPx * 4) props.time.set(null)
  else props.time.set({ at: next })
}

function onPointerDown(e: PointerEvent) {
  const next = pointAt(e.clientX)
  if (next === null) return
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  props.time.set({ at: next })
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const next = pointAt(e.clientX)
  if (next !== null) props.time.set({ at: next })
}
function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  const next = pointAt(e.clientX)
  if (next !== null) settle(next)
}

function onKey(e: KeyboardEvent) {
  if (!span.value) return
  const next = stepPoint(at.value, e.key, span.value.from, span.value.to)
  if (next === undefined) return
  e.preventDefault()
  props.time.set(next === null ? null : { at: next })
}

</script>

<template>
  <div
    class="pointer-events-auto flex min-w-0 flex-1 flex-col gap-1 rounded-lg border bg-card/90 px-3 pt-1.5 pb-1 shadow-xs backdrop-blur-md"
    :aria-busy="time.loading.value"
  >
    <div class="flex items-center gap-2 text-xs">
      <span class="truncate font-medium" :class="at === null ? 'text-muted-foreground' : 'text-foreground'" aria-live="polite">
        {{ readout }}
      </span>
      <span v-if="time.loading.value" class="text-muted-foreground">{{ t('common.loading') }}</span>
      <span v-else-if="time.error.value" class="truncate text-destructive">{{ time.error.value }}</span>
      <button
        v-if="at !== null"
        type="button"
        class="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
        @click="time.set(null)"
      >
        <RotateCcw class="size-3" />
        {{ t('graph.time.reset') }}
      </button>
    </div>

    <!-- Density: how much changed per stretch of the window. Decorative to a
         screen reader — the same counts are not information it can act on.
         Drawn empty until the timeline arrives, so the strip keeps its height. -->
    <svg class="h-3.5 w-full text-muted-foreground" :viewBox="`0 0 ${BARS} 10`" preserveAspectRatio="none" aria-hidden="true">
      <rect
        v-for="(b, i) in bars"
        :key="i"
        :x="i + 0.15"
        :y="10 - Math.max(b * 10, b > 0 ? 1.2 : 0)"
        width="0.7"
        :height="Math.max(b * 10, b > 0 ? 1.2 : 0)"
        fill="currentColor"
        :opacity="span && at !== null && (i + 0.5) / BARS > thumb ? 0.18 : 0.5"
      />
    </svg>

    <div
      ref="track"
      role="slider"
      tabindex="0"
      class="kn-time-track relative h-6 cursor-ew-resize touch-none rounded-sm outline-none select-none focus-visible:ring-3 focus-visible:ring-ring"
      :aria-label="t('graph.time.label')"
      :aria-valuemin="span?.from"
      :aria-valuemax="span?.to"
      :aria-valuenow="at ?? span?.to"
      :aria-valuetext="readout"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="dragging = false"
      @keydown="onKey"
    >
      <!-- The rule, then the stretch after the point dimmed over it. -->
      <div class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
      <div
        v-if="at !== null"
        class="absolute top-1/2 right-0 h-1.5 -translate-y-1/2 rounded-[1px] bg-muted"
        :style="{ left: `${thumb * 100}%` }"
      />

      <!-- Release tags: named ticks that jump to their instant. -->
      <button
        v-for="tag in tags"
        :key="tag.id"
        type="button"
        class="kn-time-tick group absolute top-0 flex h-6 w-6 -translate-x-1/2 justify-center outline-none"
        :style="{ left: `${span ? fractionOf(Date.parse(tag.at), span.from, span.to) * 100 : 0}%` }"
        :aria-label="t('graph.time.tagTick', { tag: tag.name, date: formatDate(tag.at) })"
        :title="`${tag.name} · ${formatDate(tag.at)}${tag.note ? ` — ${tag.note}` : ''}`"
        @pointerdown.stop
        @click="time.set({ at: Date.parse(tag.at), tag: tag.name })"
      >
        <span
          class="mt-1 h-4 w-px transition-colors group-hover:bg-foreground"
          :class="selectedTag === tag.name ? 'bg-primary' : 'bg-muted-foreground'"
        />
      </button>

      <!-- The needle. -->
      <div
        class="pointer-events-none absolute top-0 h-6 w-[3px] -translate-x-1/2 rounded-[1px] transition-[left] duration-150 ease-out motion-reduce:transition-none"
        :class="[at === null ? 'bg-muted-foreground' : 'bg-primary', dragging ? 'duration-0' : '']"
        :style="{ left: `${thumb * 100}%` }"
      />
    </div>

    <!-- Tag names under their ticks; below sm only the chosen one, which is
         the only name a phone-width strip has room to say. -->
    <div class="relative h-4 text-micro leading-4 text-muted-foreground">
      <span v-if="span && !crowdsStart" class="absolute left-0">{{ formatDayMonth(new Date(span.from)) }}</span>
      <span
        v-for="tag in tags"
        :key="tag.id"
        class="absolute max-w-24 truncate"
        :class="[labelAnchor(tagFraction(tag.at)), selectedTag === tag.name ? 'font-medium text-primary' : 'hidden sm:block']"
        :style="{ left: `${tagFraction(tag.at) * 100}%` }"
      >{{ tag.name }}</span>
      <span v-if="!crowdsEnd" class="absolute right-0">{{ t('graph.time.now') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* A tick wider than its mark: a 1px line is no target, a 24px column is. */
.kn-time-tick:focus-visible span {
  background: var(--primary);
}
</style>
