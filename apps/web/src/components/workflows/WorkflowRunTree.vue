<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { WorkflowGraph, WorkflowRunNodeInfo } from '@knowledge/contracts'
import { isBusyStatus, NODE_STATUS_CLASS, NODE_STATUS_ICON, NODE_STATUS_LABEL } from './workflow-ui'

const { t } = useI18n()

/**
 * The run's intermediate results (docs/features/17): entity → use cases → API
 * endpoints and pages, drawn as the chain it actually is.
 *
 * Depth is rendered with a hairline guide rather than indentation alone. A
 * three-level fan-out reads as three flat lists otherwise, and the whole point
 * of this panel is that the reader can see what came from what.
 *
 * Flattened here rather than recursed in the template: the server returns rows
 * in no guaranteed order, and a deep chain should not nest components.
 */
const props = defineProps<{
  nodes: WorkflowRunNodeInfo[]
  graph: WorkflowGraph
  selectedId: string | null
}>()

const emit = defineEmits<{ select: [string] }>()

const stepTitle = (stepId: string) => props.graph.steps.find((s) => s.id === stepId)?.title || stepId

/** Depth-first, so the visual order matches the chain's reading order. */
const rows = computed(() => {
  const byParent = new Map<string | null, WorkflowRunNodeInfo[]>()
  for (const node of props.nodes) {
    byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node])
  }
  const out: Array<{ node: WorkflowRunNodeInfo; depth: number; last: boolean }> = []
  const walk = (parentId: string | null, depth: number) => {
    const children = byParent.get(parentId) ?? []
    children.forEach((node, i) => {
      out.push({ node, depth, last: i === children.length - 1 })
      walk(node.id, depth + 1)
    })
  }
  walk(null, 0)
  // A node whose parent is missing would otherwise vanish from a tree it is
  // still part of.
  const seen = new Set(out.map((r) => r.node.id))
  for (const node of props.nodes) if (!seen.has(node.id)) out.push({ node, depth: 0, last: true })
  return out
})

const label = (node: WorkflowRunNodeInfo) => node.draft?.title || stepTitle(node.stepId)

/** A node that wants a person is the reason to look at this panel at all. */
const wantsYou = (node: WorkflowRunNodeInfo) => node.status === 'awaiting-review'
</script>

<template>
  <ul class="space-y-px">
    <li v-for="{ node, depth } in rows" :key="node.id" class="relative">
      <button
        type="button"
        class="focus-visible:ring-ring relative flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        :class="selectedId === node.id ? 'bg-primary/8' : 'hover:bg-muted/50'"
        :style="{ paddingLeft: `${0.5 + depth * 0.95}rem` }"
        @click="emit('select', node.id)"
      >
        <!-- Hairline guides make the fan-out legible; they are decoration for
             the eye only, so they are hidden from assistive tech. -->
        <span
          v-for="level in depth"
          :key="level"
          aria-hidden="true"
          class="bg-border absolute top-0 bottom-0 w-px"
          :style="{ left: `${0.78 + (level - 1) * 0.95}rem` }"
        />

        <component
          :is="NODE_STATUS_ICON[node.status]"
          class="relative mt-0.5 size-3.5 shrink-0"
          :class="[NODE_STATUS_CLASS[node.status], isBusyStatus(node.status) ? 'animate-spin' : '']"
        />
        <span class="min-w-0 flex-1">
          <span
            class="block truncate text-[13px] leading-snug"
            :class="wantsYou(node) ? 'font-medium' : ''"
            >{{ label(node) }}</span
          >
          <span class="text-muted-foreground block truncate text-[11px]">
            {{ stepTitle(node.stepId) }}
            <template v-if="!wantsYou(node)"> · {{ t(NODE_STATUS_LABEL[node.status]) }}</template>
          </span>
        </span>
        <!-- The one thing worth a color: this card is waiting on you. -->
        <span
          v-if="wantsYou(node)"
          class="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500"
          :title="t('workflow.waitingForReview')"
        />
      </button>
    </li>
  </ul>
</template>
