<script setup lang="ts">
// Where in a chat a capture came from (#82): "· Telegram · Platform team ·
// thread ↗", as more parts of the provenance line it sits in — each part
// brings its own separator. Unlike the session beside it, the origin is set by
// the server from the chat delivery, so it is shown as fact, not report.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next'
import type { CaptureOrigin } from '@knowledge/contracts'
import { formatDateTime } from '@/lib/format'
import { platformName } from './capture-ui'

const { t } = useI18n()

const props = defineProps<{ origin: CaptureOrigin }>()

const platform = computed(() => platformName(props.origin.platform))
const span = computed(() =>
  t('captures.origin.span', {
    from: formatDateTime(props.origin.from),
    to: formatDateTime(props.origin.to),
  }),
)
</script>

<template>
  <span aria-hidden="true">·</span>
  <span :title="span">{{ platform }}</span>
  <span aria-hidden="true">·</span>
  <span class="max-w-48 truncate" :title="origin.chatTitle ?? undefined">
    {{ origin.chatTitle ?? t('captures.origin.directMessage') }}
  </span>
  <template v-if="origin.threadUrl">
    <span aria-hidden="true">·</span>
    <a
      :href="origin.threadUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-0.5 rounded hover:text-foreground hover:underline"
      :aria-label="t('captures.origin.openThread', { platform })"
    >
      {{ t('captures.origin.thread') }}
      <ArrowUpRight class="size-3" aria-hidden="true" />
    </a>
  </template>
</template>
