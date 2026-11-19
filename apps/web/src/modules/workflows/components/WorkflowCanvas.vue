<script setup lang="ts">
/**
 * A workflow drawn — wherever it is built, read or watched (docs/features/17, #1246).
 *
 * One canvas for the builder, the detail page, a run and the wizard's preview,
 * so the four cannot disagree about what a chain looks like. A drawn map used
 * to serve every read-only view, and it laid the graph out afresh each time:
 * the arrangement an admin left in the builder was not the one anybody else
 * saw. Here every mode positions steps from `graph.layout`, falling back to the
 * same `workflow-layout` algorithm Tidy up runs.
 *
 * - `editable` is the builder: drag to move, drag between dots to connect, a
 *   popover on the selected step (the `step` slot), F2 to rename.
 * - `statuses` is a run: each step's dot and the edge into it show progress.
 * - `interactive: false` is a picture — no pan, no zoom, no selection.
 *
 * Vue Flow is client-only, so the canvas is behind a `mounted` guard —
 * rendering it during SSR produces markup the client immediately discards.
 * It only loads on workflow routes, which are lazy chunks of their own.
 */
import { computed, nextTick, onMounted, ref, useSlots, watch } from 'vue'
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
import type {
  WorkflowGraph,
  WorkflowNodeStatus,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowValidationIssue,
} from '@knowledge/contracts'
import { Popover, PopoverAnchor, PopoverContent } from '@knowledge/ui/popover'
import WorkflowStepNode from './WorkflowStepNode.vue'
import WorkflowStepEdge, { type EdgeState } from './WorkflowStepEdge.vue'
import { blankStep, stepKind } from '@/entities/workflow'
import { DEFAULT_LAYOUT, layoutPositions } from '../model/workflow-layout'

const props = withDefaults(
  defineProps<{
    graph: WorkflowGraph
    issues?: WorkflowValidationIssue[]
    selectedId?: string | null
    /** The builder. Off is every read-only view. */
    editable?: boolean
    /** Run state per step id. Absent = a definition, not a run. */
    statuses?: Record<string, WorkflowNodeStatus>
    /** How many cards a step holds in a run, shown on a fan-out. */
    counts?: Record<string, number>
    /** Off makes the canvas a picture: no pan, zoom or selection. */
    interactive?: boolean
  }>(),
  { issues: () => [], selectedId: null, editable: false, statuses: undefined, counts: undefined, interactive: true },
)

const emit = defineEmits<{
  /** `key` names an edit a burst can coalesce into (see `graphHistory`). */
  'update:graph': [graph: WorkflowGraph, key?: string]
  'update:selectedId': [string | null]
}>()

defineSlots<{
  default(): unknown
  /** The selected step's popover, in the builder. */
  step(props: { step: WorkflowStep }): unknown
}>()

const slots = useSlots()
const { t } = useI18n()

const mounted = ref(false)
onMounted(() => (mounted.value = true))

const { onConnect, onNodesInitialized, fitView, zoomIn, zoomOut, screenToFlowCoordinate } = useVueFlow()

const root = ref<HTMLElement | null>(null)

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
const positionOf = (id: string) => props.graph.layout?.[id] ?? fallback.value[id] ?? { x: 0, y: 0 }

const renamingId = ref<string | null>(null)

const nodes = computed<Node[]>(() =>
  props.graph.steps.map((step) => ({
    id: step.id,
    type: 'step',
    position: positionOf(step.id),
    selected: props.selectedId === step.id,
    data: {
      step,
      invalid: invalidSteps.value.has(step.id),
      editable: props.editable,
      renaming: renamingId.value === step.id,
      status: props.statuses?.[step.id],
      count: props.counts?.[step.id],
    },
  })),
)

/**
 * What an edge says in a run: it takes the state of the step it feeds, since
 * that step is what the hand-off is waiting on. A definition's edges say
 * nothing but direction.
 */
function edgeState(target: string): EdgeState | undefined {
  switch (props.statuses?.[target]) {
    case 'running':
    case 'materializing':
      return 'active'
    case 'awaiting-review':
      return 'waiting'
    case 'approved':
    case 'materialized':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return undefined
  }
}

const edges = computed<Edge[]>(() =>
  props.graph.steps.flatMap((step) =>
    step.next
      .filter((target) => props.graph.steps.some((s) => s.id === target))
      .map((target) => ({
        id: `${step.id}->${target}`,
        source: step.id,
        target,
        type: 'step',
        data: { editable: props.editable, state: edgeState(target) },
        markerEnd: MarkerType.ArrowClosed,
      })),
  ),
)

const selectedStep = computed(() => props.graph.steps.find((s) => s.id === props.selectedId) ?? null)

function commit(steps: WorkflowStep[], layout = props.graph.layout, key?: string) {
  emit('update:graph', { steps, layout }, key)
}

function onNodesChange(changes: NodeChange[]) {
  const layout = { ...(props.graph.layout ?? {}) }
  const moved: string[] = []
  for (const change of changes) {
    // Keyboard selection (Enter on a focused step) arrives only as a change —
    // there is no click to hear it from.
    if (change.type === 'select' && change.selected && change.id !== props.selectedId) {
      emit('update:selectedId', change.id)
    }
    // Only the end of a drag is persisted: writing every intermediate frame
    // would mark the form dirty hundreds of times per gesture. An arrow-key
    // nudge arrives the same way, one change per press.
    if (props.editable && change.type === 'position' && change.position && change.dragging === false) {
      layout[change.id] = { x: Math.round(change.position.x), y: Math.round(change.position.y) }
      moved.push(change.id)
    }
  }
  // Keyed so a run of nudges undoes as one move rather than five pixels at a time.
  if (moved.length) commit(props.graph.steps, layout, `move:${moved.join(',')}`)
}

onConnect((connection: Connection) => {
  if (!props.editable) return
  const { source, target } = connection
  if (!source || !target || source === target) return
  connect(source, target)
})

function connect(source: string, target: string) {
  commit(
    props.graph.steps.map((step) =>
      step.id === source && !step.next.includes(target) ? { ...step, next: [...step.next, target] } : step,
    ),
  )
}

function disconnect(edgeId: string) {
  if (!props.editable) return
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

/**
 * Add a step. Dropped, it lands where the pointer let go. Added with a step
 * selected, it lands to that step's right and is wired after it — building a
 * chain is then click, click, click, from the mouse or the keyboard alike.
 */
function addStep(kind: WorkflowStepKind, at?: { x: number; y: number }) {
  const meta = stepKind(kind)
  const seed = blankStep(kind, props.graph.steps.length + 1, meta ? t(meta.label) : kind)
  const id = uniqueId(seed.id)
  const after = at ? null : selectedStep.value
  let position: { x: number; y: number }
  if (at) {
    // Centred on the cursor rather than hung off its top-left corner — the card
    // should land where it looked like it was.
    position = { x: Math.round(at.x - DEFAULT_LAYOUT.nodeWidth / 2), y: Math.round(at.y - DEFAULT_LAYOUT.nodeHeight / 2) }
  } else if (after) {
    const from = positionOf(after.id)
    position = { x: from.x + DEFAULT_LAYOUT.nodeWidth + DEFAULT_LAYOUT.rankGap, y: from.y }
    // Below whatever already sits there, so a second child does not cover the first.
    const taken = (p: { x: number; y: number }) =>
      props.graph.steps.some((s) => {
        const o = positionOf(s.id)
        return Math.abs(o.x - p.x) < DEFAULT_LAYOUT.nodeWidth && Math.abs(o.y - p.y) < DEFAULT_LAYOUT.nodeHeight
      })
    while (taken(position)) position = { ...position, y: position.y + DEFAULT_LAYOUT.nodeHeight + DEFAULT_LAYOUT.nodeGap }
  } else {
    position = layoutPositions({ steps: [...props.graph.steps, { ...seed, id }] })[id] ?? { x: 0, y: 0 }
  }
  const steps = [...props.graph.steps, { ...seed, id }].map((s) =>
    after && s.id === after.id ? { ...s, next: [...s.next, id] } : s,
  )
  commit(steps, { ...(props.graph.layout ?? {}), [id]: position })
  emit('update:selectedId', id)
}

/**
 * Hand the arrangement back to the algorithm — the same one that places a step
 * with no stored position, so tidying is "lay this out as a fresh import would".
 */
function tidy() {
  if (!props.editable) return
  commit(props.graph.steps, layoutPositions(props.graph))
  void nextTick(() => fitView({ padding: 0.18, duration: 260 }))
}

/* ------------------------------------------------------------ renaming */

function nodeEl(id: string | null): HTMLElement | null {
  if (!id || !root.value) return null
  return root.value.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(id)}"]`)
}

function rename(id: string, value: string | null) {
  renamingId.value = null
  const title = value?.trim()
  const step = props.graph.steps.find((s) => s.id === id)
  if (step && title && title !== step.title) {
    commit(props.graph.steps.map((s) => (s.id === id ? { ...s, title } : s)))
  }
  // Back to the card, so the next key — an arrow, Delete, F2 — acts on it.
  void nextTick(() => nodeEl(id)?.focus())
}

function onKeydown(event: KeyboardEvent) {
  if (!props.editable || event.key !== 'F2' || !props.selectedId) return
  if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return
  event.preventDefault()
  renamingId.value = props.selectedId
}

/* ------------------------------------------------------------- popover */

/**
 * The selected step's settings, anchored to its card rather than in a drawer
 * over the graph. One popover for the canvas, re-anchored as the selection
 * moves; the `always` strategy keeps it on the card while the canvas pans.
 * Clicking away closes it without dropping the selection, so opening the
 * drawer from inside it does not lose the step the drawer is about.
 */
const popoverWanted = ref(false)
const anchor = ref<HTMLElement | null>(null)

watch(
  () => [props.selectedId, mounted.value] as const,
  async ([id]) => {
    popoverWanted.value = !!id
    await nextTick()
    anchor.value = nodeEl(id)
  },
)

const popoverOpen = computed(
  () =>
    props.editable &&
    !!slots.step &&
    popoverWanted.value &&
    !!selectedStep.value &&
    !!anchor.value &&
    renamingId.value === null,
)

function onNodeClick(id: string) {
  emit('update:selectedId', id)
  popoverWanted.value = true
}

/* ------------------------------------------------------------ drag & drop */

const dragOver = ref(false)

function onDrop(event: DragEvent) {
  dragOver.value = false
  const kind = event.dataTransfer?.getData('application/kn-step') as WorkflowStepKind | undefined
  if (!kind || !props.editable) return
  addStep(kind, screenToFlowCoordinate({ x: event.clientX, y: event.clientY }))
}

/**
 * Frame the graph again after it was replaced wholesale (an import, an
 * architect proposal). New step ids refit through `onNodesInitialized`; the
 * frame after next covers a replacement that reuses every id.
 */
function refit() {
  fitted.value = false
  requestAnimationFrame(() => requestAnimationFrame(() => void fitView({ padding: 0.18, maxZoom: 1.1, duration: 200 })))
}

defineExpose({ addStep, tidy, refit })

/**
 * Fit once the nodes have been *measured*, not once they exist: before that
 * every node reports zero width and the fit frames a cloud of points.
 *
 * The builder fits once — refitting under somebody arranging steps would move
 * the canvas out from under their hand. A read-only view refits whenever the
 * graph it shows changes, as the wizard's preview does while the architect
 * redraws it.
 */
const fitted = ref(false)
onNodesInitialized(() => {
  if (!nodes.value.length || (props.editable && fitted.value)) return
  fitted.value = true
  void nextTick(() => fitView({ padding: 0.18, maxZoom: 1.1 }))
})

// Deleting the selected step must also clear the selection, or the popover and
// drawer keep editing a step that is no longer in the graph.
watch(
  () => props.graph.steps.map((s) => s.id).join(','),
  () => {
    if (props.selectedId && !props.graph.steps.some((s) => s.id === props.selectedId)) {
      emit('update:selectedId', null)
    }
  },
)

/** The chain in words, for the region's label — the cards carry the rest. */
const description = computed(() => {
  const n = props.graph.steps.length
  if (!n) return t('workflow.map.empty')
  return t('workflow.map.summary', {
    steps: t('count.steps', { n }, n),
    chain: props.graph.steps.map((s) => s.title || s.id).join(' → '),
  })
})
</script>

<template>
  <div
    ref="root"
    role="group"
    :aria-label="description"
    class="kn-wf-canvas bg-muted/20 relative size-full min-h-0 flex-1 overflow-hidden"
    :class="[dragOver ? 'kn-wf-canvas--armed' : '', editable ? '' : 'kn-wf-canvas--readonly']"
    @dragover.prevent="editable && (dragOver = true)"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
    @keydown="onKeydown"
  >
    <div v-if="!mounted" class="text-muted-foreground flex h-full items-center justify-center text-sm">
      {{ t('workflow.canvas.loading') }}
    </div>

    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="editable"
      :nodes-connectable="editable"
      :elements-selectable="interactive"
      :nodes-focusable="interactive"
      :edges-focusable="false"
      :pan-on-drag="interactive"
      :zoom-on-scroll="interactive"
      :zoom-on-pinch="interactive"
      :zoom-on-double-click="false"
      :edges-updatable="false"
      :elevate-edges-on-select="true"
      :min-zoom="0.25"
      :max-zoom="1.8"
      :delete-key-code="null"
      :connection-radius="34"
      class="h-full"
      @nodes-change="onNodesChange"
      @node-click="(e: { node: Node }) => onNodeClick(e.node.id)"
      @node-drag-start="popoverWanted = false"
      @pane-click="emit('update:selectedId', null)"
    >
      <!-- Registered as slots rather than through `node-types`/`edge-types`:
           the slot form is the one Vue Flow types the props of, so a custom
           node stays checked instead of being cast into place. -->
      <template #node-step="nodeProps">
        <WorkflowStepNode
          v-bind="nodeProps"
          @start-rename="renamingId = nodeProps.id"
          @rename="(value: string | null) => rename(nodeProps.id, value)"
        />
      </template>

      <template #edge-step="edgeProps">
        <WorkflowStepEdge v-bind="edgeProps" @disconnect="disconnect" />
      </template>

      <Background :gap="18" :size="1.2" />
    </VueFlow>

    <!-- An empty builder says how to begin rather than showing a blank grid. -->
    <p
      v-if="mounted && editable && !graph.steps.length"
      class="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm"
    >
      {{ t('workflow.palette.hint') }}
    </p>

    <!-- Framing controls, bottom-right, matching the knowledge graph's cluster
         so the two canvases in this product are driven the same way. -->
    <div
      v-if="mounted && interactive && graph.steps.length"
      class="bg-card/90 absolute right-3 bottom-3 z-10 flex overflow-hidden rounded-lg border shadow-xs backdrop-blur-md"
    >
      <button class="kn-graph-btn" :title="t('graph.zoomOut')" :aria-label="t('graph.zoomOut')" @click="zoomOut({ duration: 160 })">
        <Minus class="size-4" />
      </button>
      <button
        class="kn-graph-btn border-x"
        :title="t('graph.fitToView')"
        :aria-label="t('graph.fitToView')"
        @click="fitView({ padding: 0.18, maxZoom: 1.1, duration: 220 })"
      >
        <Maximize2 class="size-4" />
      </button>
      <button class="kn-graph-btn" :title="t('graph.zoomIn')" :aria-label="t('graph.zoomIn')" @click="zoomIn({ duration: 160 })">
        <Plus class="size-4" />
      </button>
      <button
        v-if="editable"
        class="kn-graph-btn border-l"
        :title="t('workflow.canvas.tidyHint')"
        :aria-label="t('workflow.canvas.tidy')"
        @click="tidy"
      >
        <Wand2 class="size-4" />
      </button>
    </div>

    <Popover :open="popoverOpen" @update:open="(open: boolean) => (popoverWanted = open)">
      <PopoverAnchor :reference="anchor ?? undefined" />
      <PopoverContent
        v-if="selectedStep"
        side="bottom"
        align="start"
        :side-offset="8"
        update-position-strategy="always"
        class="w-72 p-0"
        @close-auto-focus.prevent="nodeEl(selectedId)?.focus()"
      >
        <slot name="step" :step="selectedStep" />
      </PopoverContent>
    </Popover>

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
.kn-wf-canvas:not(.kn-wf-canvas--readonly) .kn-wf-card:hover {
  border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
}
/* Indigo marks structure — here, the step you are on. */
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
  border-radius: 10px;
}
/* Keyboard focus on a step: the system's ring, on the card's own corners. */
.vue-flow__node-step:focus-visible {
  outline: none;
}
.vue-flow__node-step:focus-visible .kn-wf-card {
  box-shadow: 0 0 0 3px var(--ring);
}
.kn-wf-canvas--readonly .vue-flow__node-step {
  cursor: pointer;
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

/* Run progress along the path (#1246). The flowing dash is the canvas's one
   moving thing, and it means exactly what the pulse on a step means: work is in
   flight there now. */
.kn-wf-edge--active {
  stroke: var(--kn-panel-note);
  stroke-width: 2;
  stroke-dasharray: 6 5;
  animation: kn-wf-flow 0.9s linear infinite;
}
.kn-wf-edge--waiting {
  stroke: var(--kn-panel-warning);
  stroke-width: 2;
  stroke-dasharray: 2 4;
}
.kn-wf-edge--done {
  stroke: color-mix(in oklab, var(--kn-panel-tip) 70%, transparent);
  stroke-width: 1.75;
}
.kn-wf-edge--failed {
  stroke: var(--destructive);
  stroke-dasharray: 4 4;
}
@keyframes kn-wf-flow {
  to {
    stroke-dashoffset: -11;
  }
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
/* No hover on touch screens, so the disconnect control stays visible (#1049). */
@media (hover: none) {
  .kn-wf-cut {
    opacity: 1;
  }
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
/* Read-only: an edge still needs its handle to attach to, but nothing there
   can be grabbed, so nothing there is drawn. */
.kn-wf-canvas--readonly .vue-flow__handle {
  opacity: 0;
  pointer-events: none;
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
  /* The dash stays — it is the state — it just stops travelling. */
  .kn-wf-edge--active {
    animation: none;
  }
}
</style>
