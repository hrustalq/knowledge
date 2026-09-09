<script setup lang="ts">
/**
 * The four things a workflow can do, as a rail you drag from.
 *
 * The catalogue is closed — every kind maps to an executor in the worker — so
 * this is a complete list rather than a menu that scrolls. Showing all four at
 * once is what makes the model learnable: an operator who has never built a
 * chain can read the rail top to bottom and know the whole vocabulary before
 * placing anything.
 *
 * Drag *or* click. Dragging is the canvas gesture and where a step lands is
 * where you dropped it; clicking adds one and lets the layout decide, which is
 * the path that works with a keyboard and on a touch screen.
 */
import { useI18n } from 'vue-i18n'
import type { WorkflowStepKind } from '@knowledge/contracts'
import { STEP_KINDS } from './workflow-ui'

withDefaults(
  defineProps<{
    canManage: boolean
    /** `strip` is the narrow-screen form: one scrolling row, no hints. */
    orientation?: 'rail' | 'strip'
  }>(),
  { orientation: 'rail' },
)
const emit = defineEmits<{ add: [WorkflowStepKind] }>()

const { t } = useI18n()

function onDragStart(event: DragEvent, kind: WorkflowStepKind) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('application/kn-step', kind)
  event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <div v-if="orientation === 'strip'" class="flex items-center gap-1 overflow-x-auto">
    <span class="text-muted-foreground shrink-0 px-1 text-[11px] font-medium">
      {{ t('workflow.palette.title') }}
    </span>
    <span class="bg-border mx-0.5 h-4 w-px shrink-0" aria-hidden="true" />
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
      {{ t(kind.label) }}
    </button>
  </div>

  <div v-else class="flex min-h-0 flex-col">
    <p class="text-muted-foreground px-3 pt-3 pb-2 text-xs font-medium">{{ t('workflow.palette.title') }}</p>
    <ul class="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
      <li v-for="kind in STEP_KINDS" :key="kind.value">
        <button
          type="button"
          :disabled="!canManage"
          :draggable="canManage"
          class="kn-wf-palette-item"
          @dragstart="onDragStart($event, kind.value)"
          @click="emit('add', kind.value)"
        >
          <span class="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-md">
            <component :is="kind.icon" class="size-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-medium">{{ t(kind.label) }}</span>
            <span class="text-muted-foreground mt-0.5 block text-[11px] leading-snug">{{ t(kind.hint) }}</span>
          </span>
        </button>
      </li>
    </ul>
    <p v-if="canManage" class="text-muted-foreground border-t px-3 py-2 text-[11px] leading-snug">
      {{ t('workflow.palette.hint') }}
    </p>
  </div>
</template>

<style scoped>
.kn-wf-palette-item {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.5rem;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.5rem;
  text-align: left;
  cursor: grab;
  transition:
    background-color 140ms ease-out,
    border-color 140ms ease-out;
}
.kn-wf-palette-item:hover:not(:disabled) {
  background: color-mix(in oklab, var(--primary) 5%, transparent);
  border-color: color-mix(in oklab, var(--primary) 25%, transparent);
}
.kn-wf-palette-item:active:not(:disabled) {
  cursor: grabbing;
}
.kn-wf-palette-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
  border-color: var(--primary);
}
.kn-wf-palette-item:disabled {
  cursor: default;
  opacity: 0.5;
}
.kn-wf-palette-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
  height: 1.75rem;
  padding: 0 0.5rem;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 0.75rem;
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
.kn-wf-palette-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
.kn-wf-palette-chip:disabled {
  cursor: default;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .kn-wf-palette-item,
  .kn-wf-palette-chip {
    transition-duration: 0.01ms;
  }
}
</style>
