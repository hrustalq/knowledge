<script setup lang="ts">
/**
 * How many pages score in each 20-point band. Columns rather than a stacked
 * bar: the question is "how many are down there", and a count over each column
 * answers it without a legend. Bands wholly below the auditor's threshold take
 * the caution hue; the counts and band labels carry the meaning on their own.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { bandIsLow, bandLabel } from './quality-ui'

const props = withDefaults(defineProps<{ counts: number[]; threshold: number; compact?: boolean }>(), { compact: false })

const { t } = useI18n()

const max = computed(() => Math.max(1, ...props.counts))
const bands = computed(() =>
  props.counts.map((n, i) => ({
    n,
    label: bandLabel(i),
    low: bandIsLow(i, props.threshold),
    height: n === 0 ? 0 : Math.max(6, (n / max.value) * 100),
  })),
)
</script>

<template>
  <figure>
    <ol class="grid grid-cols-5 gap-1.5 border-b" :class="compact ? 'h-16' : 'h-28'" :aria-label="t('quality.distribution.label')">
      <li v-for="b in bands" :key="b.label" class="relative h-full">
        <span
          class="absolute inset-x-0 bottom-0 rounded-t-sm"
          :class="b.low ? 'bg-[color:var(--kn-panel-caution)]/80' : 'bg-foreground/35'"
          :style="{ height: `calc((100% - 1.25rem) * ${b.height / 100})` }"
          aria-hidden="true"
        />
        <span
          class="absolute inset-x-0 text-center text-xs leading-4 tabular-nums"
          :class="b.n === 0 ? 'text-muted-foreground' : 'font-medium'"
          :style="{ bottom: `calc((100% - 1.25rem) * ${b.height / 100} + 0.125rem)` }"
        >
          <span class="sr-only">{{ t('quality.distribution.band', { band: b.label }) }}:</span>
          {{ b.n }}
        </span>
      </li>
    </ol>
    <figcaption class="mt-1 grid grid-cols-5 gap-1.5 text-center text-[0.65rem] tabular-nums text-muted-foreground" aria-hidden="true">
      <span v-for="b in bands" :key="b.label">{{ b.label }}</span>
    </figcaption>
  </figure>
</template>
