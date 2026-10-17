<script setup lang="ts">
/**
 * A short token tinted with one panel hue (#78): an HTTP method, an AsyncAPI
 * action, a status code. The ink is the hue pulled 30% toward the foreground,
 * so it holds contrast on paper and on night ground alike; the wash is the hue
 * at 12%. Without a tone it is a neutral chip on the muted surface.
 */
import { computed } from 'vue'
import type { ApiTone } from '@/lib/api-spec'

const props = withDefaults(defineProps<{ tone: ApiTone | null; solid?: boolean }>(), { solid: true })
const style = computed(() => (props.tone ? { '--tone': `var(--kn-panel-${props.tone})` } : undefined))
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center font-mono text-[0.7rem] leading-none font-semibold tracking-wide uppercase tabular-nums"
    :class="[
      solid && 'h-5 min-w-[3.25rem] rounded-sm px-1.5',
      tone
        ? ['text-[color-mix(in_oklch,var(--tone)_70%,var(--foreground))]', solid && 'bg-[color-mix(in_oklch,var(--tone)_12%,transparent)]']
        : ['text-muted-foreground', solid && 'bg-muted'],
    ]"
    :style="style"
  >
    <slot />
  </span>
</template>
