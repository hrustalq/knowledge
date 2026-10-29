<script setup lang="ts">
// Where this tab stands with a shared draft (#80): a dot and a word in the
// editor's header, the longer story in the title. Status is a dot here, not a
// banner — the page stays the loudest thing on screen.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CollabStatus } from '@/entities/rich-editor'

const props = defineProps<{ status: CollabStatus }>()
const { t } = useI18n()

/** One key per thing a person can do about it: wait, keep typing, reload, or nothing. */
const key = computed(() => {
  const s = props.status
  if (s.state === 'stopped') return `stopped.${s.reason ?? 'unauthorized'}`
  if (s.state !== 'live') return s.state
  if (s.schemaMismatch) return 'schemaMismatch'
  return s.writable ? 'live' : 'readOnly'
})
const tone = computed(() =>
  props.status.state === 'stopped' ? 'stopped' : props.status.state === 'live' && props.status.writable ? 'live' : 'idle',
)
</script>

<template>
  <span class="kn-collab-status" role="status" :data-tone="tone" :title="t(`editor.collab.status.${key}.hint`)">
    <span class="kn-collab-dot" :data-pulse="status.state === 'connecting' || undefined" aria-hidden="true" />
    <span class="kn-collab-status-label">{{ t(`editor.collab.status.${key}.label`) }}</span>
    <span class="sr-only">{{ t(`editor.collab.status.${key}.hint`) }}</span>
  </span>
</template>
