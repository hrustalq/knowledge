<script setup lang="ts">
/**
 * A short token tinted with one panel hue (#78): an HTTP method, an AsyncAPI
 * action, a status code. Three weights, one hue:
 *
 *  - `solid` — the hue as the ground, the page's own background as the ink.
 *    The hue is pulled 22% toward the foreground first, which darkens it on
 *    paper and lifts it on night ground, so the ink holds AA on both. This is
 *    the Swagger method badge: the thing an eye finds first on a card.
 *  - `wash` — the hue at 14% under ink pulled 30% toward the foreground: a
 *    status code in a list, a method in a dense index.
 *  - `text` — the ink alone, no ground.
 *
 * Without a tone it is a neutral chip on the muted surface.
 */
import { computed } from 'vue'
import type { ApiTone } from '@/entities/api-operation/model/api-spec'

const props = withDefaults(
  defineProps<{ tone: ApiTone | null; variant?: 'solid' | 'wash' | 'text'; size?: 'sm' | 'md' }>(),
  { variant: 'wash', size: 'md' },
)
const style = computed(() => (props.tone ? { '--tone': `var(--kn-panel-${props.tone})` } : undefined))
</script>

<template>
  <span
    class="kn-tone inline-flex shrink-0 items-center justify-center font-mono leading-none font-semibold tracking-[0.04em] uppercase tabular-nums"
    :class="[
      variant !== 'text' && (size === 'sm' ? 'h-[1.15rem] min-w-[2.9rem] rounded-[4px] px-1 text-micro' : 'h-[1.4rem] min-w-[3.6rem] rounded-[5px] px-1.5 text-caption'),
      variant === 'text' && 'text-caption',
    ]"
    :data-variant="variant"
    :data-toned="tone ? '' : undefined"
    :style="style"
  >
    <slot />
  </span>
</template>

<style scoped>
.kn-tone {
  color: var(--muted-foreground);
}
.kn-tone[data-variant='wash'],
.kn-tone[data-variant='solid'] {
  background: var(--muted);
}
.kn-tone[data-toned] {
  color: color-mix(in oklab, var(--tone) 70%, var(--foreground));
}
.kn-tone[data-toned][data-variant='wash'] {
  background: color-mix(in oklab, var(--tone) 14%, transparent);
}
.kn-tone[data-toned][data-variant='solid'] {
  color: var(--background);
  background: color-mix(in oklab, var(--tone) 78%, var(--foreground));
}
</style>
