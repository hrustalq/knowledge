<script setup lang="ts">
/**
 * One step on the workflow canvas, in every mode (#1246).
 *
 * A card with a typed connection point on each side: work arrives on the left,
 * leaves on the right — the same direction `workflow-layout` arranges in, so
 * the handles agree with the arrangement instead of fighting it.
 *
 * The card says three things and stops: what the step is called, what it does,
 * and what leaves it. In a run it also says where the run has got to, with the
 * same dot the run tree uses. Anything longer — the prompt, the template, the
 * cap — lives in the drawer, because a node big enough to hold a prompt is a
 * node you cannot see the graph through.
 *
 * The title is the one field edited on the card itself: double-click, or F2 on
 * the selected step. It is a plain input over the label, so the card does not
 * change size while you type.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Handle, Position } from '@vue-flow/core'
import { Layers, TriangleAlert } from 'lucide-vue-next'
import type { WorkflowNodeStatus, WorkflowStep } from '@knowledge/contracts'
import { labelFor } from '@/shared/i18n/labels'
import { NODE_STATUS_LABEL, stepKind } from '@/entities/workflow'

const props = defineProps<{
  data: {
    step: WorkflowStep
    invalid: boolean
    editable: boolean
    renaming: boolean
    status?: WorkflowNodeStatus
    count?: number
  }
  selected?: boolean
}>()

const emit = defineEmits<{ rename: [string | null]; startRename: [] }>()

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

/**
 * Run state from the panel ramp, the vocabulary DESIGN.md gives run and stage
 * status — emerald, amber and red belong to the indexing lifecycle. The only
 * thing that moves is work genuinely in flight.
 */
const STATUS_DOT: Record<WorkflowNodeStatus, string> = {
  pending: 'bg-muted-foreground/25',
  running: 'bg-panel-note motion-safe:animate-pulse',
  materializing: 'bg-panel-note motion-safe:animate-pulse',
  'awaiting-review': 'bg-panel-warning',
  approved: 'bg-panel-tip',
  materialized: 'bg-panel-tip',
  failed: 'bg-destructive',
  rejected: 'bg-muted-foreground/40',
  skipped: 'bg-muted-foreground/40',
}

/* ------------------------------------------------------------- renaming */

const input = ref<HTMLInputElement | null>(null)
const draft = ref('')

watch(
  () => props.data.renaming,
  async (renaming) => {
    if (!renaming) return
    draft.value = props.data.step.title
    await nextTick()
    input.value?.focus()
    input.value?.select()
  },
  { immediate: true },
)

// Blur commits, so Escape has to say it already answered — otherwise the blur
// that follows unmounting the input would save what Escape meant to throw away.
let settled = false
function finish(value: string | null) {
  if (settled) return
  settled = true
  emit('rename', value)
  void nextTick(() => (settled = false))
}
</script>

<template>
  <div
    class="kn-wf-card"
    :class="[selected ? 'kn-wf-card--selected' : '', data.invalid ? 'kn-wf-card--invalid' : '']"
    @dblclick="data.editable && emit('startRename')"
  >
    <Handle type="target" :position="Position.Left" :connectable="data.editable" />

    <!-- The stack behind a fan-out card: this one becomes many, and shape says
         it without a legend. -->
    <span v-if="data.step.fanOut" class="kn-wf-stack" aria-hidden="true" />

    <div class="relative flex items-start gap-2.5 px-3 py-2.5">
      <span class="bg-muted text-muted-foreground relative mt-px grid size-6 shrink-0 place-items-center rounded-md">
        <component :is="meta?.icon" class="size-3.5" />
        <!-- The run's dot sits on the kind's tile, where the eye already is,
             rather than taking a column of its own from the title. -->
        <span
          v-if="data.status"
          class="ring-card absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2"
          :class="STATUS_DOT[data.status]"
          :title="t(NODE_STATUS_LABEL[data.status])"
        />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <input
            v-if="data.renaming"
            ref="input"
            v-model="draft"
            class="nodrag nopan text-ui focus-visible:ring-ring -mx-1 h-5 min-w-0 flex-1 rounded-sm bg-transparent px-1 leading-snug font-medium outline-none focus-visible:ring-2"
            :aria-label="t('workflow.form.name')"
            maxlength="120"
            @keydown.enter.prevent="finish(draft)"
            @keydown.esc.prevent.stop="finish(null)"
            @keydown.stop
            @blur="finish(draft)"
          />
          <span v-else class="text-ui min-w-0 flex-1 truncate leading-snug font-medium">
            {{ data.step.title || data.step.id }}
          </span>
          <TriangleAlert v-if="data.invalid" class="text-destructive size-3.5 shrink-0" />
        </span>
        <!-- `truncate` has to sit on the text itself: on the flex row it does
             nothing, and the outcome line ran out under the card's edge. -->
        <span class="text-muted-foreground text-caption mt-1 flex items-center gap-1 leading-snug">
          <Layers v-if="data.step.fanOut" class="size-3 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ outcome }}</span>
          <span v-if="data.count && data.count > 1" class="shrink-0 tabular-nums">· {{ data.count }}</span>
        </span>
        <span v-if="data.status" class="sr-only">{{ t(NODE_STATUS_LABEL[data.status]) }}</span>
      </span>
    </div>

    <Handle type="source" :position="Position.Right" :connectable="data.editable" />
  </div>
</template>
