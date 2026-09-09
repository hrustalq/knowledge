<script setup lang="ts">
/**
 * Three steps, and only three: choosing, parsing, reviewing. Submitting is the
 * primary action of the review step rather than a step of its own — a stage
 * whose entire content is one button is a click tax, and the thing you press
 * submit on should be the thing you were just reading.
 *
 * Rendered as an ordered list because that is what it is: assistive technology
 * gets "step 2 of 3, current" for free, which no arrangement of divs provides.
 */
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'

const { t } = useI18n()

const props = defineProps<{ current: 0 | 1 | 2 }>()

const STEPS = ['Destination', 'Parse', 'Review'] as const

const state = computed(() =>
  STEPS.map((label, i) => ({
    label,
    index: i,
    done: i < props.current,
    active: i === props.current,
  })),
)
</script>

<template>
  <ol class="flex items-center gap-1 text-sm" :aria-label="t('import.steps')">
    <li
      v-for="(step, i) in state"
      :key="step.label"
      class="flex items-center gap-1"
      :aria-current="step.active ? 'step' : undefined"
    >
      <span
        class="flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors duration-200"
        :class="
          step.active
            ? 'bg-primary/10 text-primary font-medium'
            : step.done
              ? 'text-foreground'
              : 'text-muted-foreground'
        "
      >
        <span
          class="flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-medium tabular-nums transition-colors duration-200"
          :class="
            step.done
              ? 'border-primary bg-primary text-primary-foreground'
              : step.active
                ? 'border-primary text-primary'
                : 'border-border text-muted-foreground'
          "
        >
          <Check v-if="step.done" class="size-3" aria-hidden="true" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        {{ step.label }}
      </span>

      <!-- The rule fills as you advance: the only place the flow shows length,
           and the one bit of motion that makes progress feel like progress. -->
      <span v-if="i < state.length - 1" class="relative h-px w-6 shrink-0 overflow-hidden bg-border sm:w-10" aria-hidden="true">
        <span
          class="kn-rule absolute inset-0 origin-left bg-primary"
          :style="{ transform: `scaleX(${step.done ? 1 : 0})` }"
        />
      </span>
    </li>
  </ol>
</template>

<style scoped>
.kn-rule {
  /* Slower than the step transition it follows, so the rule reads as a
     consequence of advancing rather than part of the same flicker. */
  transition: transform 340ms cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-reduced-motion: reduce) {
  .kn-rule {
    transition-duration: 0ms;
  }
}
</style>
