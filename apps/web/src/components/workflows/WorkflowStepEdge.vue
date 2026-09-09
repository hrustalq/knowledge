<script setup lang="ts">
/**
 * A connection, with a way to remove it that is not "click and hope".
 *
 * The previous canvas deleted an edge on plain click, which meant a mis-aimed
 * pan through a connection silently rewired the workflow. Here the line carries
 * a disconnect control that appears on hover — the affordance is visible before
 * it is used, and clicking the line itself does nothing.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Position } from '@vue-flow/core'
import { X } from 'lucide-vue-next'

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  markerEnd?: string
  data?: { canManage: boolean }
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
  <BaseEdge :id="id" :path="path[0]" :marker-end="markerEnd" class="kn-wf-edge" />
  <EdgeLabelRenderer v-if="data?.canManage">
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
