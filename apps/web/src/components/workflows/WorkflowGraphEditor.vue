<script setup lang="ts">
/**
 * The editing canvas (docs/features/17).
 *
 * The canvas edits *structure* only — dragging writes `graph.layout`, drawing a
 * connection writes `step.next`. What a step does lives in the inspector.
 *
 * It stays on Vue Flow while every read-only view of the same graph moved to a
 * drawn canvas (`WorkflowMap`), and the split is not a compromise: editing
 * needs real elements to grab — handles, hit targets, a focus ring the browser
 * manages — and reading needs none of them. What keeps the two honest is that
 * they share `workflow-layout`: Tidy up writes the exact coordinates the map
 * would have drawn, so the arrangement you leave is the arrangement everyone
 * else sees.
 *
 * Vue Flow is client-only, so the canvas is behind a `mounted` guard —
 * rendering it during SSR produces markup the client immediately discards, the
 * same reason `Autocomplete.vue` guards its `<Teleport>`.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  MarkerType,
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
// Vue Flow ships unstyled, and its node positioning *is* CSS: without these the
// canvas renders blank even though the nodes are in the DOM.
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { Maximize2, Minus, Plus, Wand2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { WorkflowGraph, WorkflowStep, WorkflowStepKind, WorkflowValidationIssue } from '@knowledge/contracts'
import WorkflowStepNode from './WorkflowStepNode.vue'
import WorkflowStepEdge from './WorkflowStepEdge.vue'
import { blankStep, stepKind } from './workflow-ui'
import { DEFAULT_LAYOUT, layoutPositions } from './workflow-layout'

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

const { t } = useI18n()

const mounted = ref(false)
onMounted(() => (mounted.value = true))

const { onConnect, onNodesInitialized, fitView, zoomIn, zoomOut, screenToFlowCoordinate } = useVueFlow()

/** Errors are per-step, so a node shows its own problem rather than a banner. */
const invalidSteps = computed(() => {
  const set = new Set<string>()
  for (const issue of props.issues) {
    if (issue.stepId && issue.severity === 'error') set.add(issue.stepId)
  }
  return set
})

// A step with no stored position is laid out by the same algorithm Tidy up
// runs, not stacked at the origin. An imported or model-designed graph carries
// no layout at all, and every node landing on one pixel looks like one node.
const fallback = computed(() => layoutPositions(props.graph))

const nodes = computed<Node[]>(() =>
  props.graph.steps.map((step) => ({
    id: step.id,
    type: 'step',
    position: props.graph.layout?.[step.id] ?? fallback.value[step.id] ?? { x: 0, y: 0 },
    selected: props.selectedId === step.id,
    data: { step, invalid: invalidSteps.value.has(step.id), connectable: props.canManage },
  })),
)

const edges = computed<Edge[]>(() =>
  props.graph.steps.flatMap((step) =>
    step.next
      .filter((target) => props.graph.steps.some((s) => s.id === target))
      .map((target) => ({
        id: `${step.id}->${target}`,
        source: step.id,
        target,
        type: 'step',
        data: { canManage: props.canManage },
        markerEnd: MarkerType.ArrowClosed,
      })),
  ),
)

function commit(steps: WorkflowStep[], layout = props.graph.layout) {
  emit('update:graph', { steps, layout })
}

function onNodesChange(changes: NodeChange[]) {
  if (!props.canManage) return
  const layout = { ...(props.graph.layout ?? {}) }
  let moved = false
  for (const change of changes) {
    // Only the end of a drag is persisted: writing every intermediate frame
    // would mark the form dirty hundreds of times per gesture.
    if (change.type === 'position' && change.position && change.dragging === false) {
      layout[change.id] = { x: Math.round(change.position.x), y: Math.round(change.position.y) }
      moved = true
    }
  }
  if (moved) commit(props.graph.steps, layout)
}

onConnect((connection: Connection) => {
  if (!props.canManage) return
  const { source, target } = connection
  if (!source || !target || source === target) return
  commit(
    props.graph.steps.map((step) =>
      step.id === source && !step.next.includes(target) ? { ...step, next: [...step.next, target] } : step,
    ),
  )
})

function disconnect(edgeId: string) {
  if (!props.canManage) return
  const [source, target] = edgeId.split('->')
  commit(
    props.graph.steps.map((step) =>
      step.id === source ? { ...step, next: step.next.filter((n) => n !== target) } : step,
    ),
  )
}

/** Ids are what a running node points at, so a collision would orphan one. */
function uniqueId(base: string): string {
  let id = base
  let n = 2
  while (props.graph.steps.some((s) => s.id === id)) id = `${base}-${n++}`
  return id
}

function addStep(kind: WorkflowStepKind, at?: { x: number; y: number }) {
  const meta = stepKind(kind)
  const seed = blankStep(kind, props.graph.steps.length + 1, meta ? t(meta.label) : kind)
  const id = uniqueId(seed.id)
  // Dropped where the pointer let go, centred on the cursor rather than hung
  // off its top-left corner — the card should land where it looked like it was.
  const position = at
    ? { x: Math.round(at.x - DEFAULT_LAYOUT.nodeWidth / 2), y: Math.round(at.y - DEFAULT_LAYOUT.nodeHeight / 2) }
    : (layoutPositions({ steps: [...props.graph.steps, { ...seed, id }] })[id] ?? { x: 0, y: 0 })
  commit([...props.graph.steps, { ...seed, id }], { ...(props.graph.layout ?? {}), [id]: position })
  emit('update:selectedId', id)
}

/**
 * Hand the arrangement back to the algorithm.
 *
 * The same function the read-only map lays out with, so tidying is literally
 * "make the canvas agree with every preview of this workflow".
 */
function tidy() {
  if (!props.canManage) return
  commit(props.graph.steps, layoutPositions(props.graph))
  void nextTick(() => fitView({ padding: 0.18, duration: 260 }))
}

/* ------------------------------------------------------------ drag & drop */

const dragOver = ref(false)

function onDrop(event: DragEvent) {
  dragOver.value = false
  const kind = event.dataTransfer?.getData('application/kn-step') as WorkflowStepKind | undefined
  if (!kind || !props.canManage) return
  addStep(kind, screenToFlowCoordinate({ x: event.clientX, y: event.clientY }))
}

defineExpose({ addStep, tidy })

/**
 * Fit once the nodes have been *measured*, not once they exist.
 *
 * Watching `nodes.length` (and `fit-view-on-init` before it) runs while every
 * node still reports zero width, so the fit computed a bounding box of points
 * and left the graph at 100% with its right-hand steps hanging off the canvas.
 * `onNodesInitialized` is the event that means the dimensions are real.
 */
const fitted = ref(false)
onNodesInitialized(() => {
  if (fitted.value || !nodes.value.length) return
  fitted.value = true
  void nextTick(() => fitView({ padding: 0.18 }))
})

// Deleting the selected step must also clear the selection, or the inspector
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
  <div
    class="bg-muted/20 relative min-h-0 flex-1 overflow-hidden"
    :class="dragOver ? 'kn-wf-canvas--armed' : ''"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
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
      :elevate-edges-on-select="true"
      :min-zoom="0.25"
      :max-zoom="1.8"
      :delete-key-code="null"
      :connection-radius="34"
      class="h-full"
      @nodes-change="onNodesChange"
      @node-click="(e: { node: Node }) => emit('update:selectedId', e.node.id)"
      @pane-click="emit('update:selectedId', null)"
    >
      <!-- Registered as slots rather than through `node-types`/`edge-types`:
           the slot form is the one Vue Flow types the props of, so a custom
           node stays checked instead of being cast into place. -->
      <template #node-step="nodeProps">
        <WorkflowStepNode v-bind="nodeProps" />
      </template>

      <template #edge-step="edgeProps">
        <WorkflowStepEdge v-bind="edgeProps" @disconnect="disconnect" />
      </template>

      <Background :gap="18" :size="1.2" />
    </VueFlow>

    <!-- Framing controls, bottom-right, matching the knowledge graph's cluster
         so the two canvases in this product are driven the same way. -->
    <div
      v-if="mounted && graph.steps.length"
      class="bg-card/90 absolute right-3 bottom-3 flex overflow-hidden rounded-lg border shadow-xs backdrop-blur-md"
    >
      <button class="kn-graph-btn" :title="t('graph.zoomOut')" :aria-label="t('graph.zoomOut')" @click="zoomOut({ duration: 160 })">
        <Minus class="size-4" />
      </button>
      <button
        class="kn-graph-btn border-x"
        :title="t('graph.fitToView')"
        :aria-label="t('graph.fitToView')"
        @click="fitView({ padding: 0.18, duration: 220 })"
      >
        <Maximize2 class="size-4" />
      </button>
      <button class="kn-graph-btn" :title="t('graph.zoomIn')" :aria-label="t('graph.zoomIn')" @click="zoomIn({ duration: 160 })">
        <Plus class="size-4" />
      </button>
      <button
        v-if="canManage"
        class="kn-graph-btn border-l"
        :title="t('workflow.canvas.tidyHint')"
        :aria-label="t('workflow.canvas.tidy')"
        @click="tidy"
      >
        <Wand2 class="size-4" />
      </button>
    </div>

    <slot />
  </div>
</template>

<style>
/* Vue Flow renders its own node shell, so these have to be unscoped. */

/* A card lifts off the canvas by being whiter than it, not by casting a shadow
   — the inversion this design system uses everywhere instead of depth. */
.kn-wf-card {
  position: relative;
  width: 216px;
  min-height: 72px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--card-foreground);
  text-align: left;
  transition:
    border-color 160ms ease-out,
    box-shadow 160ms ease-out;
}
.kn-wf-card:hover {
  border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
}
/* Indigo marks structure — here, the step you are editing. */
.kn-wf-card--selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 14%, transparent);
}
.kn-wf-card--invalid {
  border-color: var(--destructive);
}
.kn-wf-card--invalid.kn-wf-card--selected {
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 14%, transparent);
}

/* The fan-out stack. Two cards behind one, drawn with the card's own border and
   ground so it reads as more of the same thing rather than as a shadow. */
.kn-wf-stack,
.kn-wf-stack::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  z-index: -1;
}
.kn-wf-stack {
  transform: translate(5px, 5px);
  opacity: 0.7;
}
.kn-wf-stack::before {
  transform: translate(5px, 5px);
  opacity: 0.7;
}

.vue-flow__node-step {
  /* The card draws its own everything; Vue Flow's default chrome would double
     the border and round the corner twice. */
  background: transparent;
  border: 0;
  padding: 0;
  width: auto;
}
.vue-flow__node-step.selected .kn-wf-card {
  border-color: var(--primary);
}

.kn-wf-edge {
  stroke: color-mix(in oklab, var(--muted-foreground) 55%, transparent);
  stroke-width: 1.5;
  transition: stroke 160ms ease-out;
}
.vue-flow__edge:hover .kn-wf-edge,
.vue-flow__edge.selected .kn-wf-edge {
  stroke: var(--primary);
}
.vue-flow__arrowhead * {
  fill: color-mix(in oklab, var(--muted-foreground) 55%, transparent);
  stroke: none;
}
.vue-flow__edge:hover .vue-flow__arrowhead * {
  fill: var(--primary);
}

/* Disconnect: hidden until the connection is hovered, so the line is quiet at
   rest and the control is visible before it is used. */
.kn-wf-cut {
  position: absolute;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--muted-foreground);
  opacity: 0;
  pointer-events: all;
  transition:
    opacity 140ms ease-out,
    color 140ms ease-out,
    border-color 140ms ease-out;
}
.vue-flow__edge:hover .kn-wf-cut,
.kn-wf-cut:hover,
.kn-wf-cut:focus-visible {
  opacity: 1;
}
.kn-wf-cut:hover {
  color: var(--destructive);
  border-color: var(--destructive);
}

.vue-flow__handle {
  width: 9px;
  height: 9px;
  border: 2px solid var(--card);
  background: color-mix(in oklab, var(--muted-foreground) 60%, transparent);
  transition:
    background 140ms ease-out,
    transform 140ms ease-out;
}
.kn-wf-card:hover .vue-flow__handle,
.vue-flow__handle:hover,
.vue-flow__handle.connecting {
  background: var(--primary);
  transform: scale(1.25);
}

/* Dragging a step over the canvas: the ground answers before the drop. */
.kn-wf-canvas--armed::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
  border-radius: inherit;
  box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--primary) 45%, transparent);
  background: color-mix(in oklab, var(--primary) 5%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .kn-wf-card,
  .kn-wf-edge,
  .kn-wf-cut,
  .vue-flow__handle {
    transition-duration: 0.01ms;
  }
}
</style>
