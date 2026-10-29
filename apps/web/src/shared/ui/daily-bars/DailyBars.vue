<script setup lang="ts">
/**
 * One bar per UTC day over a fixed window, optionally stacked (#79). Lifted
 * from the AI usage panel, which drew it first.
 *
 * Inline markup rather than a charting library: this repo ships none, and a
 * bar series does not justify adding one. Colours come from the theme tokens
 * the caller passes, so it follows light/dark like everything else.
 *
 * The API returns only days that have data. Rendering those alone made one
 * busy day fill the whole width as a solid block, so every day of the window
 * gets a bar here and a spike reads as a spike.
 */
import { computed } from 'vue'
import { formatDayMonth } from '@/shared/utils/format'

export interface BarSegment {
  /** Tailwind background classes for this segment. */
  class: string
}

const props = withDefaults(
  defineProps<{
    from: string
    to: string
    /** Sparse days, `YYYY-MM-DD`; `values` line up with `segments`, bottom first. */
    points: Array<{ date: string; values: number[] }>
    segments: BarSegment[]
    label: string
    /** The hover text of one day. */
    pointTitle: (date: string, values: number[]) => string
    height?: number
  }>(),
  { height: 88 },
)

const bars = computed(() => {
  const byDate = new Map(props.points.map((p) => [p.date, p.values]))
  const start = new Date(props.from)
  const end = new Date(props.to).getTime()
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
  const max = Math.max(1, ...props.points.map((p) => sum(p.values)))
  const out: Array<{ date: string; values: number[]; total: number; heights: number[] }> = []
  for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    const values = byDate.get(date) ?? props.segments.map(() => 0)
    const total = sum(values)
    // A day with any traffic keeps a visible sliver rather than rounding to nothing.
    const barH = total === 0 ? 0 : Math.max(2, Math.round((total / max) * props.height))
    out.push({ date, values, total, heights: values.map((v) => (total === 0 ? 0 : (v / total) * barH)) })
  }
  return out
})
</script>

<template>
  <div>
    <div
      class="border-border/70 flex items-end gap-px border-b"
      :style="{ height: `${height}px` }"
      role="img"
      :aria-label="label"
    >
      <div
        v-for="bar in bars"
        :key="bar.date"
        class="flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-t-[2px]"
        :class="bar.total === 0 ? 'bg-muted' : ''"
        :style="{ height: bar.total === 0 ? '2px' : undefined }"
        :title="pointTitle(bar.date, bar.values)"
      >
        <div
          v-for="(segment, i) in segments"
          :key="i"
          class="transition-colors"
          :class="segment.class"
          :style="{ height: `${bar.heights[i]}px` }"
        />
      </div>
    </div>
    <div class="text-muted-foreground mt-1.5 flex justify-between text-xs">
      <span>{{ formatDayMonth(from) }}</span>
      <span>{{ formatDayMonth(to) }}</span>
    </div>
  </div>
</template>
