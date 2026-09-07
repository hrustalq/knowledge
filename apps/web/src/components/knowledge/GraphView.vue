<script setup lang="ts">
// Feature 06 (docs/features/06): renders the document relation graph with
// Cytoscape.js — a canvas-rendered, purpose-built graph library — instead of
// the old hand-rolled SVG + manual force loop. This gets us a real
// force-directed layout, smooth wheel/drag zoom & pan, and correct scaling
// at any node count for free, and fixes the old version's crowding at
// depth > 1 (nodes were clamped inside a fixed 860x560 viewBox with no way
// to zoom in).
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useResizeObserver } from '@vueuse/core'
import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, StylesheetJson } from 'cytoscape'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { DocumentGraphResponse } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{ documentId: string }>()
const router = useRouter()

const depth = ref(1)
const graph = ref<DocumentGraphResponse | null>(null)
const error = ref<string | null>(null)
const containerEl = ref<HTMLElement | null>(null)
const cy = shallowRef<Core | null>(null)

// Entity nodes get a fixed amber accent — a decorative constant (matches the
// old version's amber-500/600), not a theme token, so it stays legible
// against both the light and dark background.
const ENTITY_FILL = '#f59e0b'
const ENTITY_STROKE = '#d97706'

/** Reads a design-token CSS variable so the graph always matches the current theme (light/dark). */
function themeVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function buildStyle(): StylesheetJson {
  const border = themeVar('--border', '#d9d9d9')
  const background = themeVar('--background', '#ffffff')
  const foreground = themeVar('--foreground', '#111111')
  const primary = themeVar('--primary', '#3b3b8f')
  const primaryForeground = themeVar('--primary-foreground', '#ffffff')
  const muted = themeVar('--muted-foreground', '#777777')

  return [
    {
      selector: 'node.document',
      style: {
        shape: 'round-rectangle',
        width: 'label',
        height: 32,
        padding: '10px',
        'background-color': background,
        'border-color': border,
        'border-width': 1.5,
        label: 'data(label)',
        'font-size': 11,
        'font-weight': 500,
        color: foreground,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-max-width': '140px',
        'text-wrap': 'ellipsis',
      },
    },
    {
      selector: 'node.document.root',
      style: {
        'background-color': primary,
        'border-color': primary,
        color: primaryForeground,
      },
    },
    {
      selector: 'node.document.clickable',
      style: { 'transition-property': 'border-width', 'transition-duration': 120 },
    },
    {
      selector: 'node.document.clickable:active',
      style: { 'overlay-opacity': 0.08, 'overlay-color': primary },
    },
    {
      selector: 'node.entity',
      style: {
        shape: 'ellipse',
        width: 14,
        height: 14,
        'background-color': ENTITY_FILL,
        'border-color': ENTITY_STROKE,
        'border-width': 1,
        label: 'data(label)',
        'font-size': 9,
        color: muted,
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-max-width': '110px',
        'text-wrap': 'ellipsis',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.2,
        'line-color': muted,
        'target-arrow-color': muted,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': 8,
        color: muted,
        'text-rotation': 'autorotate',
        'text-background-color': background,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
      },
    },
    {
      selector: 'edge.inferred',
      style: { 'line-style': 'dashed' },
    },
  ]
}

function toElements(g: DocumentGraphResponse): ElementDefinition[] {
  const nodes: ElementDefinition[] = g.nodes.map((n) => ({
    data: { id: n.id, label: n.label, kind: n.kind },
    classes: [
      n.kind === 'document' ? 'document' : 'entity',
      n.id === props.documentId ? 'root' : '',
      n.kind === 'document' && n.id !== props.documentId ? 'clickable' : '',
    ]
      .filter(Boolean)
      .join(' '),
  }))
  const edges: ElementDefinition[] = g.edges.map((e, i) => ({
    data: { id: `e${i}`, source: e.from, target: e.to, label: e.type },
    classes: e.extractor === 'inferred' ? 'inferred' : '',
  }))
  return [...nodes, ...edges]
}

function destroyGraph() {
  cy.value?.destroy()
  cy.value = null
}

async function render() {
  if (!graph.value || !containerEl.value) return
  destroyGraph()
  const instance = cytoscape({
    container: containerEl.value,
    elements: toElements(graph.value),
    style: buildStyle(),
    wheelSensitivity: 0.25,
    minZoom: 0.2,
    maxZoom: 2.5,
    layout: {
      name: 'cose',
      animate: false,
      nodeRepulsion: 9000,
      idealEdgeLength: 90,
      edgeElasticity: 120,
      nodeOverlap: 16,
      gravity: 40,
      numIter: 1500,
    },
  })
  instance.on('tap', 'node.document', (evt) => {
    const id = evt.target.id()
    if (id !== props.documentId) void router.push(`/documents/${id}`)
  })
  instance.on('mouseover', 'node.clickable', () => {
    instance.container()!.style.cursor = 'pointer'
  })
  instance.on('mouseout', 'node.clickable', () => {
    instance.container()!.style.cursor = ''
  })
  cy.value = instance
  await nextTick()
  instance.resize()
  instance.fit(undefined, 32)
}

async function load() {
  error.value = null
  graph.value = null
  destroyGraph()
  try {
    const res = await apiFetch<DocumentGraphResponse>(
      `/v1/documents/${props.documentId}/graph?depth=${depth.value}`,
    )
    graph.value = res
    await nextTick()
    void render()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function zoomBy(factor: number) {
  const instance = cy.value
  if (!instance) return
  const level = Math.min(Math.max(instance.zoom() * factor, instance.minZoom()), instance.maxZoom())
  instance.zoom({ level, renderedPosition: { x: instance.width() / 2, y: instance.height() / 2 } })
}

function fitToView() {
  cy.value?.fit(undefined, 32)
}

// Re-applies the stylesheet (theme-derived colors) when the app's light/dark
// class toggles, so the graph never goes stale against the current theme.
let themeObserver: MutationObserver | null = null
onMounted(() => {
  themeObserver = new MutationObserver(() => cy.value?.style(buildStyle()))
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

useResizeObserver(containerEl, () => {
  cy.value?.resize()
})

onMounted(() => void load())
watch(depth, () => void load())
watch(() => props.documentId, () => void load())
onBeforeUnmount(() => {
  themeObserver?.disconnect()
  destroyGraph()
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-3">
      <Label for="graph-depth" class="text-sm font-normal text-muted-foreground">Depth</Label>
      <Select v-model="depth">
        <SelectTrigger id="graph-depth" size="sm" class="text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="1">1 hop</SelectItem>
          <SelectItem :value="2">2 hops</SelectItem>
          <SelectItem :value="3">3 hops</SelectItem>
        </SelectContent>
      </Select>
      <span v-if="graph" class="text-xs text-muted-foreground">
        {{ graph.nodes.length }} nodes · {{ graph.edges.length }} edges · dashed = inferred
      </span>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <Skeleton v-else-if="!graph" class="h-[480px] w-full" />
    <p v-else-if="graph.edges.length === 0" class="text-sm text-muted-foreground">
      No relations yet — add frontmatter <code>relations:</code> or explicit relations, then index.
    </p>

    <div v-else class="relative h-[480px] w-full overflow-hidden rounded-lg border bg-background">
      <div ref="containerEl" class="h-full w-full" />
      <div class="absolute right-2 top-2 flex flex-col gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur-sm">
        <Button variant="ghost" size="icon-sm" title="Zoom in" @click="zoomBy(1.25)">
          <ZoomIn class="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Zoom out" @click="zoomBy(0.8)">
          <ZoomOut class="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Fit to view" @click="fitToView">
          <Maximize2 class="size-4" />
        </Button>
      </div>
    </div>
  </div>
</template>
