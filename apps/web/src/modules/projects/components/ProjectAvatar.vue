<script setup lang="ts">
/**
 * A project's face, in one of three states (docs/features/24).
 *
 * An uploaded picture, a chosen emoji on a colour, or — when neither is set,
 * which is every project until someone bothers — the monogram from
 * `core/monogram.ts`: two letters on a hue hashed from the id. That fallback is
 * not a placeholder waiting to be filled in. It is stable across sessions and
 * machines, which is what makes the tile the thing you recognise in the
 * sidebar before you have read the label.
 *
 * One component because the same three-way choice is drawn at four sizes in
 * four places, and a project that looked like a photograph in the sidebar and
 * like initials on its own page would read as two different projects.
 */
import { computed, ref, watch } from 'vue'
import { avatarColor } from '@/core/avatar'
import { initialsOf } from '@/core/monogram'
import { resolveAssetUrl } from '@/shared/api/api'

const props = withDefaults(
  defineProps<{
    projectId: string
    name: string
    avatarUrl?: string | null
    avatarEmoji?: string | null
    avatarColor?: string | null
    /** Matches the tile sizes already in use: sidebar rows, headers, page banner. */
    size?: 'xs' | 'sm' | 'md' | 'lg'
  }>(),
  { avatarUrl: null, avatarEmoji: null, avatarColor: null, size: 'sm' },
)

const BOX: Record<string, string> = {
  xs: 'size-5 rounded-[6px] text-micro',
  sm: 'size-7 rounded-md text-caption',
  md: 'size-9 rounded-lg text-sm',
  lg: 'size-14 rounded-xl text-lg',
}
/** The emoji, not the box, carries the size: a glyph at 9px is a smudge. */
const GLYPH: Record<string, string> = {
  xs: 'text-caption',
  sm: 'text-base',
  md: 'text-xl',
  lg: 'text-3xl',
}

const broken = ref(false)
watch(
  () => props.avatarUrl,
  () => (broken.value = false),
)
const url = computed(() =>
  props.avatarUrl && !broken.value ? resolveAssetUrl(props.avatarUrl) : null,
)
const background = computed(() => {
  if (url.value) return 'transparent'
  if (props.avatarEmoji && props.avatarColor) return props.avatarColor
  return avatarColor(props.projectId)
})
</script>

<template>
  <span
    class="grid shrink-0 place-items-center overflow-hidden font-semibold text-white"
    :class="BOX[size]"
    :style="{ backgroundColor: background }"
    :title="name"
  >
    <img
      v-if="url"
      :src="url"
      :alt="name"
      class="size-full object-cover"
      loading="lazy"
      decoding="async"
      @error="broken = true"
    />
    <span v-else-if="avatarEmoji" :class="GLYPH[size]" aria-hidden="true">{{ avatarEmoji }}</span>
    <span v-else aria-hidden="true">{{ initialsOf(name) }}</span>
  </span>
</template>
