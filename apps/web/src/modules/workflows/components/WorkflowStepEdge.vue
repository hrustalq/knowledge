<script setup lang="ts">
/**
 * A connection, with a way to remove it that is not "click and hope".
 *
 * Clicking the line does nothing: a disconnect control appears on hover, so a
 * mis-aimed pan through a connection cannot silently rewire the workflow.
 *
 * In a run the line also carries progress (#1246): the edge into a step that is
 * working flows, one waiting for a person holds still in the warning hue, and a
 * finished hand-off is drawn solid. Direction is the arrowhead, always.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Position } from '@vue-flow/core'
import { X } from 'lucide-vue-next'

export type EdgeState = 'active' | 'waiting' | 'done' | 'failed'

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  markerEnd?: string
  data?: { editable: boolean; state?: EdgeState }
}>()

const emit = defineEmits<{ disconnect: [string] }>()

const { t } = useI18n()

const path = computed(() =>
  getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  }),
)
</script>

<template>
  <BaseEdge
    :id="id"
    :path="path[0]"
    :marker-end="markerEnd"
    class="kn-wf-edge"
    :class="data?.state ? `kn-wf-edge--${data.state}` : ''"
  />
  <EdgeLabelRenderer v-if="data?.editable">
    <button
      type="button"
      class="kn-wf-cut nodrag nopan"
      :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }"
      :title="t('workflow.disconnect')"
      :aria-label="t('workflow.disconnect')"
      @click.stop="emit('disconnect', id)"
    >
      <X class="size-3" />
    </button>
  </EdgeLabelRenderer>
</template>
