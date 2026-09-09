<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { VueFlow, useVueFlow, type Connection, type Edge, type Node, type NodeChange } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
// Vue Flow ships unstyled, and its node positioning *is* CSS: without these the
// canvas renders blank even though the nodes are in the DOM.
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import { Plus, TriangleAlert } from 'lucide-vue-next'
import type { WorkflowGraph, WorkflowStep, WorkflowStepKind, WorkflowValidationIssue } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { blankStep, stepKind, STEP_KINDS } from './workflow-ui'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/**
 * Drag-and-drop editor for a workflow definition (docs/features/17).
 *
 * The canvas edits *structure* only — dragging writes `graph.layout`, drawing a
 * connection writes `step.next`. Everything about what a step does lives in the
 * side panel, because a node big enough to hold a prompt is a node you cannot
 * see the graph through.
 *
 * VueFlow is client-only, so the canvas is behind a `mounted` guard: rendering
 * it during SSR produces markup the client immediately discards, which is the
 * same reason `Autocomplete.vue` guards its `<Teleport>`.
 */
const props = defineProps<{
  graph: WorkflowGraph
  issues: WorkflowValidationIssue[]
  selectedId: string | null
  canManage: boolean
}>()

const emit = defineEmits<{
  'update:graph': [WorkflowGraph]
  'update:selectedId': [string | null]
}>()

const mounted = ref(false)
onMounted(() => (mounted.value = true))

const { onConnect, removeEdges, fitView } = useVueFlow()

/** Errors are per-step, so a node can show its own problem rather than a banner. */
const issuesByStep = computed(() => {
  const map = new Map<string, WorkflowValidationIssue[]>()
  for (const issue of props.issues) {
    if (!issue.stepId) continue
    map.set(issue.stepId, [...(map.get(issue.stepId) ?? []), issue])
  }
  return map
})

// A step with no stored position is laid out in a column rather than stacked at
// the origin: a freshly imported definition has no layout, and every node
// landing on the same pixel looks like one node.
const nodes = computed<Node[]>(() =>
  props.graph.steps.map((step, index) => {
    const stored = props.graph.layout?.[step.id]
    const worst = issuesByStep.value.get(step.id)?.some((i) => i.severity === 'error')
    return {
      id: step.id,
      position: stored ?? { x: 40 + (index % 3) * 260, y: 40 + Math.floor(index / 3) * 160 },
      data: { step, invalid: worst },
      type: 'default',
      class: [
        'kn-wf-node',
        props.selectedId === step.id ? 'kn-wf-node--selected' : '',
        worst ? 'kn-wf-node--invalid' : '',
      ].join(' '),
      label: step.title || step.id,
    }
  }),
)

const edges = computed<Edge[]>(() =>
  props.graph.steps.flatMap((step) =>
    step.next
      .filter((target) => props.graph.steps.some((s) => s.id === target))
      .map((target) => ({
        id: `${step.id}->${target}`,
        source: step.id,
        target,
        animated: false,
        class: 'kn-wf-edge',
      })),
  ),
)

/** What a node tells you at a glance: its job, then what comes out of it. */
function nodeSummary(step: WorkflowStep): string {
  const kind = stepKind(step.kind) ? t(stepKind(step.kind)!.label) : step.kind
  if (step.fanOut) return `${kind} → a list of ${step.produces?.category ?? 'item'} pages`
  if (step.produces) {
    return `${kind} → one ${step.produces.category} page${step.autoApprove ? ', published straight away' : ''}`
  }
  return `${kind} → context for the next step`
}

function commit(steps: WorkflowStep[], layout = props.graph.layout) {
  emit('update:graph', { steps, layout })
}

function onNodesChange(changes: NodeChange[]) {
  if (!props.canManage) return
  const layout = { ...(props.graph.layout ?? {}) }
  let moved = false
  for (const change of changes) {
    // Only persist the end of a drag: writing every intermediate frame would
    // mark the form dirty hundreds of times per gesture.
    if (change.type === 'position' && change.position && change.dragging === false) {
      layout[change.id] = { x: Math.round(change.position.x), y: Math.round(change.position.y) }
      moved = true
    }
  }
  if (moved) commit(props.graph.steps, layout)
}

onConnect((connection: Connection) => {
  if (!props.canManage) return
  if (!connection.source || !connection.target || connection.source === connection.target) return
  commit(
    props.graph.steps.map((step) =>
      step.id === connection.source && !step.next.includes(connection.target as string)
        ? { ...step, next: [...step.next, connection.target as string] }
        : step,
    ),
  )
})

function onEdgeClick(edgeId: string) {
  if (!props.canManage) return
  const [source, target] = edgeId.split('->')
  commit(
    props.graph.steps.map((step) =>
      step.id === source ? { ...step, next: step.next.filter((n) => n !== target) } : step,
    ),
  )
  removeEdges([edgeId])
}

function addStep(kind: WorkflowStepKind) {
  const step = blankStep(kind, props.graph.steps.length + 1, t(stepKind(kind)?.label ?? 'workflow.stepKind.fallback'))
  // Ids must stay unique: they are what a running node points at.
  let id = step.id
  let n = 2
  while (props.graph.steps.some((s) => s.id === id)) id = `${step.id}-${n++}`
  const created = { ...step, id }
  commit([...props.graph.steps, created], {
    ...(props.graph.layout ?? {}),
    [id]: { x: 40 + (props.graph.steps.length % 3) * 260, y: 40 + Math.floor(props.graph.steps.length / 3) * 160 },
  })
  emit('update:selectedId', id)
}

// `fit-view-on-init` fires before the nodes computed has resolved, so the first
// paint left the graph parked in a corner. Fit once, when nodes first appear.
const fitted = ref(false)
watch(
  () => nodes.value.length,
  async (count) => {
    if (fitted.value || count === 0) return
    fitted.value = true
    await nextTick()
    fitView({ padding: 0.2 })
  },
  { immediate: true },
)

// Deleting the selected step must also clear the selection, or the side panel
// keeps editing a step that is no longer in the graph.
watch(
  () => props.graph.steps.map((s) => s.id).join(','),
  () => {
    if (props.selectedId && !props.graph.steps.some((s) => s.id === props.selectedId)) {
      emit('update:selectedId', null)
    }
  },
)
</script>

<template>
  <div class="bg-muted/15 relative min-h-0 flex-1 overflow-hidden rounded-lg border">
    <div
      v-if="canManage"
      class="bg-background/90 absolute top-3 left-3 z-10 flex max-w-[calc(100%_-_1.5rem)] items-center gap-0.5 overflow-x-auto rounded-lg border p-1 shadow-xs backdrop-blur"
    >
      <span class="text-muted-foreground shrink-0 px-2 text-[11px] font-medium whitespace-nowrap">Add a step</span>
      <span class="bg-border mx-0.5 h-4 w-px" aria-hidden="true" />
      <Button
        v-for="kind in STEP_KINDS"
        :key="kind.value"
        variant="ghost"
        size="sm"
        class="h-7 shrink-0 gap-1.5 px-2 text-xs whitespace-nowrap"
        :title="t(kind.hint)"
        @click="addStep(kind.value)"
      >
        <component :is="kind.icon" class="size-3.5" />
        {{ t(kind.label) }}
      </Button>
    </div>

    <div v-if="!mounted" class="text-muted-foreground flex h-full items-center justify-center text-sm">
      {{ t('workflow.canvas.loading') }}
    </div>

    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="canManage"
      :nodes-connectable="canManage"
      :edges-updatable="false"
      fit-view-on-init
      :min-zoom="0.3"
      :max-zoom="1.6"
      class="h-full"
      @nodes-change="onNodesChange"
      @node-click="(e: { node: Node }) => emit('update:selectedId', e.node.id)"
      @pane-click="emit('update:selectedId', null)"
      @edge-click="(e: { edge: Edge }) => onEdgeClick(e.edge.id)"
    >
      <template #node-default="slotProps">
        <div class="w-[12rem] px-3 py-2.5 text-left">
          <div class="flex items-start gap-2">
            <component
              :is="stepKind(slotProps.data.step.kind)?.icon"
              class="text-muted-foreground mt-px size-4 shrink-0"
            />
            <span class="min-w-0 flex-1 text-[13px] leading-snug font-medium">
              {{ slotProps.data.step.title || slotProps.id }}
            </span>
            <TriangleAlert v-if="slotProps.data.invalid" class="text-destructive mt-px size-3.5 shrink-0" />
          </div>
          <p class="text-muted-foreground mt-1.5 pl-6 text-[11px] leading-snug">
            {{ nodeSummary(slotProps.data.step) }}
          </p>
        </div>
      </template>

      <Background :gap="16" />
      <Controls :show-interactive="false" />
    </VueFlow>

    <p
      v-if="mounted && graph.steps.length === 0"
      class="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm"
    >
      <Plus class="mr-1.5 size-4" /> {{ t('workflow.canvas.addStepToBegin') }}
    </p>
  </div>
</template>

<style>
/* VueFlow renders its own node shell, so these have to be unscoped. */
/* A card lifts off the canvas by being whiter than it, not by casting a shadow
   — the inversion this design system uses everywhere instead of depth. */
.kn-wf-node {
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--card-foreground);
  transition:
    border-color 160ms ease-out,
    box-shadow 160ms ease-out;
}
.kn-wf-node:hover {
  border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
}
/* Indigo marks structure — here, the step you are editing. */
.kn-wf-node--selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 14%, transparent);
}
.kn-wf-node--invalid {
  border-color: var(--destructive);
}
.kn-wf-node--invalid.kn-wf-node--selected {
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 14%, transparent);
}
.vue-flow__edge-path {
  stroke: color-mix(in oklab, var(--muted-foreground) 55%, transparent);
  stroke-width: 1.5;
  transition: stroke 160ms ease-out;
}
.vue-flow__edge:hover .vue-flow__edge-path {
  stroke: var(--destructive);
}
/* An edge is removed by clicking it, so it has to say so on hover. */
.vue-flow__edge {
  cursor: pointer;
}
.vue-flow__handle {
  background: var(--primary);
  border: none;
  width: 7px;
  height: 7px;
}
.vue-flow__controls-button {
  background: var(--card);
  border-bottom: 1px solid var(--border);
  fill: var(--foreground);
}
</style>
