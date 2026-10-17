<script setup lang="ts">
/**
 * One 0–100 value as a hairline bar. Not measured (null) is drawn as an empty,
 * dashed track and says so — the auditor's rule that "not measured" is not
 * "zero" holds on screen too.
 */
import { computed } from 'vue'
import { isLow } from './quality-ui'

const props = defineProps<{ value: number | null; threshold: number; label: string }>()

const width = computed(() => `${Math.max(0, Math.min(100, props.value ?? 0))}%`)
const low = computed(() => isLow(props.value, props.threshold))
</script>

<template>
  <div
    v-if="value !== null"
    role="meter"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="value"
    class="relative h-1.5 w-full overflow-hidden rounded-sm bg-muted"
  >
    <div
      class="absolute inset-y-0 left-0 rounded-sm transition-[width] duration-300 ease-out motion-reduce:transition-none"
      :class="low ? 'bg-[color:var(--kn-panel-caution)]' : 'bg-foreground/55'"
      :style="{ width }"
    />
  </div>
  <div v-else class="h-1.5 w-full rounded-sm border border-dashed" :aria-label="label" role="img" />
</template>
