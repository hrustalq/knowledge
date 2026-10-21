<script setup lang="ts">
// How far to trust the answer above, and why (docs/features/38).
//
// A word, not a percentage: "medium" is honest about what a derived score is,
// and the reasons behind it are a hover away. Nothing here is the model's own
// opinion of itself — every reason is something the harness observed, which is
// why each one can be a plain sentence.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useHydratedMediaQuery } from '@/lib/use-hydrated'
import { ShieldCheck, ShieldAlert, ShieldQuestion, ShieldOff } from 'lucide-vue-next'
import type { AnswerConfidence } from '@knowledge/contracts'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const props = defineProps<{ confidence: AnswerConfidence }>()

const { t } = useI18n()
const open = ref(false)
const canHover = useHydratedMediaQuery('(hover: hover)')

const icon = computed(() => {
  switch (props.confidence.level) {
    case 'high':
      return ShieldCheck
    case 'medium':
      return ShieldQuestion
    case 'low':
      return ShieldAlert
    default:
      return ShieldOff
  }
})
const percent = computed(() => Math.round(props.confidence.score * 100))
</script>

<template>
  <component :is="canHover ? HoverCard : Popover" v-model:open="open" :open-delay="200" :close-delay="120">
    <component :is="canHover ? HoverCardTrigger : PopoverTrigger" as-child>
      <button type="button" class="kn-confidence" :data-level="confidence.level" :aria-label="t('assistant.confidence.title')">
        <component :is="icon" class="size-3" aria-hidden="true" />
        {{ t(`assistant.confidence.${confidence.level}`) }}
      </button>
    </component>
    <component :is="canHover ? HoverCardContent : PopoverContent" class="w-72 text-sm" :side-offset="8">
      <p class="font-medium">
        {{ t('assistant.confidence.title') }}
        <span class="text-muted-foreground">· {{ t(`assistant.confidence.${confidence.level}`) }}, {{ percent }}%</span>
      </p>
      <ul v-if="confidence.reasons.length" class="mt-2 space-y-1 text-muted-foreground">
        <li v-for="r in confidence.reasons" :key="r.key" class="flex gap-2">
          <span aria-hidden="true" :class="r.key === 'verified-sources' ? 'text-panel-tip' : 'text-panel-warning'">•</span>
          <span>{{ t(`assistant.confidence.reason.${r.key}`, { n: r.value }) }}</span>
        </li>
      </ul>
      <p v-else class="mt-2 text-muted-foreground">{{ t('assistant.confidence.noReasons') }}</p>
    </component>
  </component>
</template>

<style scoped>
.kn-confidence {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
  font-size: var(--kn-text-caption);
  color: var(--muted-foreground);
  transition: color 120ms ease-out, border-color 120ms ease-out;
}
.kn-confidence:hover,
.kn-confidence:focus-visible {
  color: var(--foreground);
  border-color: var(--ring);
  outline: none;
}
/* The level colours the glyph only. The pill stays quiet: a loud red badge
   under every weak answer would teach readers to stop reading badges. */
.kn-confidence[data-level='high'] > svg {
  color: var(--kn-panel-tip);
}
.kn-confidence[data-level='medium'] > svg {
  color: var(--kn-panel-warning);
}
.kn-confidence[data-level='low'] > svg,
.kn-confidence[data-level='none'] > svg {
  color: var(--destructive);
}
</style>
