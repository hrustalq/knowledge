<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowGraph, WorkflowRunNodeInfo } from '@knowledge/contracts'
import { isBusyStatus, NODE_STATUS_CLASS, NODE_STATUS_ICON, NODE_STATUS_LABEL } from './workflow-ui'

/**
 * The run's intermediate results (docs/features/17): entity → use cases → API
 * endpoints and pages, as the tree it actually is.
 *
 * Rendered from the flat node list rather than a nested one, because the server
 * returns rows and the parent of a node may arrive in the same page as its
 * child. Depth is computed once here rather than recursed in the template, so
 * a deep chain cannot blow the component stack.
 */
const props = defineProps<{
  nodes: WorkflowRunNodeInfo[]
  graph: WorkflowGraph
  selectedId: string | null
}>()

const emit = defineEmits<{ select: [string] }>()

const stepTitle = (stepId: string) =>
  props.graph.steps.find((s) => s.id === stepId)?.title || stepId

/** Flatten depth-first so the visual order matches the chain's reading order. */
const rows = computed(() => {
  const byParent = new Map<string | null, WorkflowRunNodeInfo[]>()
  for (const node of props.nodes) {
    const key = node.parentId
    byParent.set(key, [...(byParent.get(key) ?? []), node])
  }
  const out: Array<{ node: WorkflowRunNodeInfo; depth: number }> = []
  const walk = (parentId: string | null, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      out.push({ node, depth })
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  // A node whose parent is missing (deleted mid-run) would otherwise vanish
  // from a tree it is still part of.
  const seen = new Set(out.map((r) => r.node.id))
  for (const node of props.nodes) if (!seen.has(node.id)) out.push({ node, depth: 0 })
  return out
})

const label = (node: WorkflowRunNodeInfo) => node.draft?.title || stepTitle(node.stepId)
</script>

<template>
  <ul class="space-y-0.5">
    <li v-for="{ node, depth } in rows" :key="node.id">
      <button
        type="button"
        class="focus-visible:ring-ring flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        :class="selectedId === node.id ? 'bg-primary/10' : 'hover:bg-muted/60'"
        :style="{ paddingLeft: `${0.5 + depth * 1}rem` }"
        @click="emit('select', node.id)"
      >
        <component
          :is="NODE_STATUS_ICON[node.status]"
          class="size-3.5 shrink-0"
          :class="[NODE_STATUS_CLASS[node.status], isBusyStatus(node.status) ? 'animate-spin' : '']"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm">{{ label(node) }}</span>
          <span class="text-muted-foreground block truncate text-[11px]">
            {{ stepTitle(node.stepId) }} · {{ NODE_STATUS_LABEL[node.status] }}
          </span>
        </span>
      </button>
    </li>
  </ul>
</template>
