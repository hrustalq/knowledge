<script setup lang="ts">
/**
 * One step on the editing canvas.
 *
 * A card with a typed connection point on each side: work arrives on the left,
 * leaves on the right — the same direction `workflow-layout` arranges in, so
 * the handles agree with the arrangement instead of fighting it.
 *
 * The card says three things and stops: what the step is called, what it does,
 * and what leaves it. Anything longer — the prompt, the category, the cap —
 * lives in the inspector, because a node big enough to hold a prompt is a node
 * you cannot see the graph through.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Handle, Position } from '@vue-flow/core'
import { Layers, TriangleAlert } from 'lucide-vue-next'
import type { WorkflowStep } from '@knowledge/contracts'
import { labelFor } from '@/lib/labels'
import { stepKind } from './workflow-ui'

const props = defineProps<{
  data: { step: WorkflowStep; invalid: boolean; connectable: boolean }
  selected?: boolean
}>()

const { t } = useI18n()

const meta = computed(() => stepKind(props.data.step.kind))

/** What leaves this step, in the operator's words rather than the schema's. */
const outcome = computed(() => {
  const step = props.data.step
  if (step.fanOut) return t('workflow.node.manyItems', { category: category.value })
  if (step.produces) {
    return step.autoApprove
      ? t('workflow.node.onePageAuto', { category: category.value })
      : t('workflow.node.onePage', { category: category.value })
  }
  return t('workflow.node.context')
})

const category = computed(() => {
  const c = props.data.step.produces?.category
  // Free text in the database, so an unknown value falls back to itself rather
  // than rendering `category.onboarding` on the card (docs/features/18).
  return c ? labelFor(t, 'category', c) : t('workflow.node.item')
})
</script>

<template>
  <div
    class="kn-wf-card"
    :class="[selected ? 'kn-wf-card--selected' : '', data.invalid ? 'kn-wf-card--invalid' : '']"
  >
    <Handle type="target" :position="Position.Left" :connectable="data.connectable" />

    <!-- The stack behind a fan-out card, matching the drawn map exactly: this
         one becomes many, and shape says it without a legend. -->
    <span v-if="data.step.fanOut" class="kn-wf-stack" aria-hidden="true" />

    <div class="relative flex items-start gap-2.5 px-3 py-2.5">
      <span class="bg-muted text-muted-foreground mt-px grid size-6 shrink-0 place-items-center rounded-md">
        <component :is="meta?.icon" class="size-3.5" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-[13px] leading-snug font-medium">
            {{ data.step.title || data.step.id }}
          </span>
          <TriangleAlert v-if="data.invalid" class="text-destructive size-3.5 shrink-0" />
        </span>
        <!-- `truncate` has to sit on the text itself: on the flex row it does
             nothing, and the outcome line ran out under the card's edge. -->
        <span class="text-muted-foreground mt-1 flex items-center gap-1 text-[11px] leading-snug">
          <Layers v-if="data.step.fanOut" class="size-3 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ outcome }}</span>
        </span>
      </span>
    </div>

    <Handle type="source" :position="Position.Right" :connectable="data.connectable" />
  </div>
</template>
