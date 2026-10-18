<script setup lang="ts">
/**
 * A score over time, one point per audit day.
 *
 * Drawn as a measured chart, not a decorative sparkline: the x axis is time
 * (two audits a week apart sit a week apart), the y axis is the 0–100 scale
 * with the auditor's threshold ruled across it, and the first and last dates
 * and the latest value are labelled. The line is an SVG stretched over a
 * percent grid with a non-scaling stroke, and the points and labels are HTML
 * placed on the same grid — so it is the same chart at any width, and the
 * server renders exactly what the client hydrates.
 *
 * For a screen reader the chart is one image with a summary, and the series
 * itself is a list.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { QualityHistoryPoint } from '@knowledge/contracts'
import { formatDayMonth } from '@/lib/format'
import { historyDay, isLow } from './quality-ui'

const props = withDefaults(defineProps<{ points: QualityHistoryPoint[]; threshold: number; compact?: boolean }>(), {
  compact: false,
})

const { t } = useI18n()

const placed = computed(() => {
  const times = props.points.map((p) => historyDay(p.date).getTime())
  const first = times[0] ?? 0
  const span = (times[times.length - 1] ?? first) - first
  return props.points.map((p, i) => ({
    ...p,
    x: span === 0 ? 50 : ((times[i] - first) / span) * 100,
    y: 100 - Math.max(0, Math.min(100, p.overall)),
    label: formatDayMonth(historyDay(p.date)),
  }))
})
const line = computed(() => placed.value.map((p) => `${p.x},${p.y}`).join(' '))
const last = computed(() => placed.value[placed.value.length - 1])
const first = computed(() => placed.value[0])
const delta = computed(() => (placed.value.length > 1 ? last.value.overall - first.value.overall : 0))

const summary = computed(() =>
  placed.value.length > 1
    ? t('quality.history.summary', {
        from: first.value.overall,
        to: last.value.overall,
        start: first.value.label,
        end: last.value.label,
      })
    : '',
)
</script>

<template>
  <figure v-if="placed.length > 1" class="space-y-1.5">
    <div class="flex gap-2" :class="compact ? 'h-20' : 'h-36'" role="img" :aria-label="summary">
      <!-- The scale, outside the plot so labels never sit on the line. -->
      <div class="relative w-6 shrink-0 text-[0.65rem] leading-none tabular-nums text-muted-foreground" aria-hidden="true">
        <span class="absolute right-0 top-0 -translate-y-1/2">100</span>
        <span
          class="absolute right-0 -translate-y-1/2 text-[color:var(--kn-panel-caution)]"
          :style="{ top: `${100 - threshold}%` }"
        >{{ threshold }}</span>
        <span class="absolute bottom-0 right-0 translate-y-1/2">0</span>
      </div>

      <div class="relative min-w-0 flex-1 border-b border-l" aria-hidden="true">
        <div class="absolute inset-x-0 top-0 border-t border-dashed border-border" />
        <!-- The threshold: below it the auditor files a finding. -->
        <div
          class="absolute inset-x-0 border-t border-dashed border-[color:var(--kn-panel-caution)] opacity-60"
          :style="{ top: `${100 - threshold}%` }"
        />
        <svg class="absolute inset-0 size-full overflow-visible text-foreground/70" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline
            :points="line"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <span
          v-for="(p, i) in placed"
          :key="p.date"
          class="absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
          :class="[
            i === placed.length - 1 ? 'size-2' : 'size-1.5',
            isLow(p.overall, threshold) ? 'bg-[color:var(--kn-panel-caution)]' : 'bg-foreground',
          ]"
          :style="{ left: `${p.x}%`, top: `${p.y}%` }"
          :title="`${p.label}: ${p.overall}`"
        />
        <span
          class="absolute -translate-y-[160%] whitespace-nowrap text-xs font-medium tabular-nums"
          :class="last.x > 85 ? '-translate-x-full pr-1' : 'pl-1'"
          :style="{ left: `${last.x}%`, top: `${last.y}%` }"
        >{{ last.overall }}</span>
      </div>
    </div>

    <figcaption class="flex justify-between gap-2 pl-8 text-xs text-muted-foreground tabular-nums">
      <span>{{ first.label }}</span>
      <span v-if="delta !== 0" :class="delta < 0 ? 'text-[color:var(--kn-panel-caution)]' : 'text-foreground'">
        {{ t(delta > 0 ? 'quality.history.up' : 'quality.history.down', { n: Math.abs(delta) }) }}
      </span>
      <span>{{ last.label }}</span>
    </figcaption>

    <ol class="sr-only">
      <li v-for="p in placed" :key="p.date">{{ p.label }}: {{ p.overall }}</li>
    </ol>
  </figure>

  <p v-else-if="placed.length === 1" class="text-xs text-muted-foreground">
    {{ t('quality.history.single', { date: placed[0].label }) }}
  </p>
</template>
