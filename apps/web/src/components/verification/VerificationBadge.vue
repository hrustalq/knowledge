<script setup lang="ts">
/**
 * The state pill (docs/features/39): a dot in the state's hue and its short
 * name. Drawn wherever a page is listed — the status bar, a search hit, a
 * health row — so the same word means the same thing everywhere.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SourceVerificationState } from '@knowledge/contracts'
import { verificationDotClass, verificationTone } from './verification-ui'

const props = withDefaults(
  defineProps<{
    state: SourceVerificationState
    /** `xs` for a list row, `sm` for the bar. */
    size?: 'xs' | 'sm'
    /** Overrides the default hover text (the state's name). */
    title?: string
  }>(),
  { size: 'sm', title: undefined },
)

const { t } = useI18n()
const tone = computed(() => verificationTone(props.state))
const dot = computed(() => verificationDotClass(props.state))
const label = computed(() => t(`verification.state.${props.state}`))

/**
 * Ink and stroke per tone, as utilities rather than a scoped stylesheet so the
 * dark variant rides the same `.dark` mechanism as every other token in
 * style.css. The hues are the panel ramp's, matching the row mark
 * (verification-ui); `-ink` is the ramp's text-strength step.
 */
const toneClass = computed(() => {
  switch (tone.value) {
    case 'ok':
      return 'border-panel-tip/40 text-panel-tip-ink'
    case 'warn':
      return 'border-panel-warning/45 text-panel-warning-ink'
    case 'bad':
      return 'border-panel-caution/45 text-panel-caution-ink'
    default:
      return 'text-muted-foreground'
  }
})
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border text-xs font-medium"
    :class="[size === 'xs' ? 'px-1.5 py-0' : 'px-2 py-0.5', toneClass]"
    :data-tone="tone"
    :title="title ?? label"
  >
    <span class="size-1.5 rounded-full" :class="dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>
