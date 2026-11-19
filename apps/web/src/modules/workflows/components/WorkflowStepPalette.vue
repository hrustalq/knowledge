<script setup lang="ts">
/**
 * The things a workflow can do, as buttons on the canvas's toolbar (#1246).
 *
 * The catalogue is closed — every kind maps to an executor in the worker — so
 * this is the whole list rather than a menu that scrolls. Showing every kind at
 * once is what makes the model learnable: an operator who has never built a
 * chain can read the row and know the vocabulary before placing anything.
 *
 * Drag *or* click. Dragging is the canvas gesture and where a step lands is
 * where you dropped it; clicking adds one after the selected step (or lets the
 * layout place it), which is the path that works with a keyboard and on touch.
 */
import { useI18n } from 'vue-i18n'
import type { WorkflowStepKind } from '@knowledge/contracts'
import { STEP_KINDS } from '@/entities/workflow'

defineProps<{ canManage: boolean }>()
const emit = defineEmits<{ add: [WorkflowStepKind] }>()

const { t } = useI18n()

function onDragStart(event: DragEvent, kind: WorkflowStepKind) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('application/kn-step', kind)
  event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <div class="flex items-center gap-0.5" role="group" :aria-label="t('workflow.palette.title')">
    <button
      v-for="kind in STEP_KINDS"
      :key="kind.value"
      type="button"
      :disabled="!canManage"
      :draggable="canManage"
      class="kn-wf-palette-chip"
      :title="t(kind.hint)"
      @dragstart="onDragStart($event, kind.value)"
      @click="emit('add', kind.value)"
    >
      <component :is="kind.icon" class="size-3.5 shrink-0" />
      <!-- Icons alone on a phone, where five names do not fit beside the
           history controls; named from `sm` up, because five glyphs nobody has
           learned yet are not a vocabulary. -->
      <span class="sr-only sm:not-sr-only">{{ t(kind.short) }}</span>
    </button>
  </div>
</template>

<style scoped>
.kn-wf-palette-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
  height: 1.75rem;
  min-width: 1.75rem;
  justify-content: center;
  padding: 0 0.5rem;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: var(--kn-text-xs);
  white-space: nowrap;
  cursor: grab;
  transition:
    background-color 140ms ease-out,
    border-color 140ms ease-out;
}
.kn-wf-palette-chip:hover:not(:disabled) {
  background: color-mix(in oklab, var(--primary) 6%, transparent);
  border-color: color-mix(in oklab, var(--primary) 25%, transparent);
}
.kn-wf-palette-chip:active:not(:disabled) {
  cursor: grabbing;
}
.kn-wf-palette-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
}
.kn-wf-palette-chip:disabled {
  cursor: default;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .kn-wf-palette-chip {
    transition-duration: 0.01ms;
  }
}
</style>
