<script setup lang="ts">
// Initials avatar with a deterministic per-user hue (no avatar uploads exist).
//
// `ai` swaps the initials for a glyph: the assistant posts under the identity
// of whoever ran it, so without this a machine finding wears a colleague's
// face — which is exactly the thing a reader must not be misled about.
import { computed } from 'vue'
import { Bot } from 'lucide-vue-next'
import { avatarColor, avatarInitials } from '@/lib/avatar'

const props = withDefaults(
  defineProps<{ userId: string; name?: string; size?: 'sm' | 'md'; ai?: boolean }>(),
  { name: undefined, size: 'md', ai: false },
)

const label = computed(() => (props.ai ? 'Assistant' : (props.name ?? props.userId)))
const initials = computed(() => avatarInitials(label.value))
</script>

<template>
  <span
    class="grid shrink-0 select-none place-items-center rounded-full font-medium text-white"
    :class="size === 'sm' ? 'size-5 text-[9px]' : 'size-7 text-[11px]'"
    :style="{ backgroundColor: ai ? 'var(--kn-panel-important)' : avatarColor(userId) }"
    :title="label"
  >
    <Bot v-if="ai" :class="size === 'sm' ? 'size-3' : 'size-4'" aria-hidden="true" />
    <template v-else>{{ initials }}</template>
  </span>
</template>
