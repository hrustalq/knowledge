<script setup lang="ts">
// A person's face: their picture when they have uploaded one, initials on a
// deterministic per-user hue when they have not.
//
// The initials are not a placeholder waiting to be replaced — most people never
// upload anything, and "no picture" still has to read as *someone in
// particular*, which is what the stable hue buys (see lib/avatar.ts).
//
// `ai` swaps the face for a glyph: an agent posts under the identity of whoever
// tagged it, so without this a machine's remark wears a colleague's face —
// exactly the thing a reader must not be misled about. It wins over `src` for
// the same reason.
import { computed, ref, watch } from 'vue'
import { Bot } from 'lucide-vue-next'
import { avatarColor, avatarInitials } from '@/lib/avatar'
import { resolveAssetUrl } from '@/lib/api'

const props = withDefaults(
  defineProps<{
    userId: string
    name?: string
    size?: 'sm' | 'md'
    ai?: boolean
    /** Bare `/v1/...` path from the API; resolved to a loadable URL here. */
    src?: string | null
  }>(),
  { name: undefined, size: 'md', ai: false, src: null },
)

const label = computed(() => (props.ai ? 'Assistant' : (props.name ?? props.userId)))
const initials = computed(() => avatarInitials(label.value))

// A picture that fails to load must not leave a blank disc where a face was.
// Reset on change, so replacing a broken avatar with a good one recovers
// without a reload.
const broken = ref(false)
watch(
  () => props.src,
  () => (broken.value = false),
)
const url = computed(() =>
  props.src && !props.ai && !broken.value ? resolveAssetUrl(props.src) : null,
)
</script>

<template>
  <span
    class="grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-medium text-white"
    :class="size === 'sm' ? 'size-5 text-[9px]' : 'size-7 text-[11px]'"
    :style="{
      backgroundColor: ai ? 'var(--kn-panel-important)' : url ? 'transparent' : avatarColor(userId),
    }"
    :title="label"
  >
    <Bot v-if="ai" :class="size === 'sm' ? 'size-3' : 'size-4'" aria-hidden="true" />
    <img
      v-else-if="url"
      :src="url"
      :alt="label"
      class="size-full object-cover"
      loading="lazy"
      decoding="async"
      @error="broken = true"
    />
    <template v-else>{{ initials }}</template>
  </span>
</template>
