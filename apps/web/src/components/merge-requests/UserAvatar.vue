<script setup lang="ts">
// Initials avatar with a deterministic per-user hue (no avatar uploads exist).
import { computed } from 'vue'

const props = withDefaults(defineProps<{ userId: string; name?: string; size?: 'sm' | 'md' }>(), {
  name: undefined,
  size: 'md',
})

const label = computed(() => props.name ?? props.userId)
const initials = computed(() => {
  const n = label.value.trim()
  if (!n || n === 'dev') return 'D'
  const parts = n.split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || n.slice(0, 2).toUpperCase()
})
const hue = computed(() => {
  let h = 0
  for (const ch of props.userId) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})
</script>

<template>
  <span
    class="grid shrink-0 select-none place-items-center rounded-full font-medium text-white"
    :class="size === 'sm' ? 'size-5 text-[9px]' : 'size-7 text-[11px]'"
    :style="{ backgroundColor: `hsl(${hue} 55% 45%)` }"
    :title="label"
  >{{ initials }}</span>
</template>
