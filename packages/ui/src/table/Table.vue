<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../cn"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  /** Pin the first cell of every row on narrow screens, so the identifying column stays in view (#1070). */
  stickyFirst?: boolean
}>()

// Hover and selected rows tint their first cell with the same opaque mix as the row's translucent bg-muted/50.
const STICKY_FIRST =
  '[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-10 [&_tr>*:first-child]:bg-background [&_tr:hover>*:first-child]:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] [&_tr[data-state=selected]>*:first-child]:bg-muted max-xl:[&_tr>*:first-child]:shadow-[inset_-1px_0_0_var(--border)]'
</script>

<template>
  <div data-slot="table-container" class="relative w-full overflow-auto">
    <table data-slot="table" :class="cn('w-full caption-bottom text-sm', props.stickyFirst && STICKY_FIRST, props.class)">
      <slot />
    </table>
  </div>
</template>
