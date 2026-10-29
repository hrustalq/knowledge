<script setup lang="ts">
/**
 * One page's neighbourhood in the knowledge graph (docs/features/06).
 *
 * Two sizes of the same thing. In the rail it is a compact canvas with a depth
 * selector — enough to answer "is this page connected, and to what". Maximized
 * it becomes the full instrument: filters, legend, layout controls, framing.
 * Both draw through `KnowledgeGraph`, so a passage the reader recognised in the
 * widget is the same shape, colour and size once it fills the screen.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import type { DocumentGraphResponse } from '@knowledge/contracts'
import { fetchApi } from '@/shared/api/queries'
import { Label } from '@/shared/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import KnowledgeGraph from '@/entities/graph/components/KnowledgeGraph.vue'
import GraphCanvas from '@/entities/graph/components/GraphCanvas.vue'
import { DEFAULT_OPTIONS, type GraphNodeInput } from '@/entities/graph/model/graph-model'
import { useGraphTime } from '@/entities/graph/model/use-graph-time'
import { getWorkspaceId } from '@/shared/api/api'

const props = withDefaults(
  defineProps<{ documentId: string; variant?: 'rail' | 'full' }>(),
  { variant: 'rail' },
)

const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

const depth = ref(props.variant === 'full' ? 2 : 1)
const graph = ref<DocumentGraphResponse | null>(null)
const error = ref<string | null>(null)
const stats = ref({ nodes: 0, edges: 0 })

/**
 * The widget's own options: no filter panel here, so entities are on and the
 * label floor is dropped — at one hop there is room to name everything, and a
 * graph of unnamed dots in a 20rem column tells the reader nothing.
 */
const railOptions = computed(() => ({ ...DEFAULT_OPTIONS, labelZoom: 0.35 }))

const toNodes = (res: DocumentGraphResponse): GraphNodeInput[] =>
  res.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    category: n.category,
    entityType: n.entityType,
    distance: n.distance,
  }))

/**
 * #81: maximized, the neighbourhood can be read at a point in time. The rail
 * widget stays on now — a 20rem column has no room for a timeline, and the
 * page beside it is the page as it is.
 */
const route = useRoute()
const graphTime = props.variant === 'full'
  ? useGraphTime({
      now: () => (graph.value ? { nodes: toNodes(graph.value), edges: graph.value.edges } : null),
      fetchAt: async (asOf) => {
        const res = await fetchApi(queryClient, '/v1/documents/{id}/graph', {
          path: { id: props.documentId },
          query: { depth: String(depth.value), asOf },
        })
        return { pair: { nodes: toNodes(res), edges: res.edges }, resolvedAsOf: res.resolvedAsOf }
      },
      scopeQuery: () => ({ workspaceId: getWorkspaceId() }),
      initial: typeof route.query.asOf === 'string' ? route.query.asOf : null,
    })
  : null

const shown = computed(() => (graphTime ? graphTime.display.value : graph.value ? { nodes: toNodes(graph.value), edges: graph.value.edges } : null))
const nodes = computed<GraphNodeInput[]>(() => shown.value?.nodes ?? [])
const edges = computed(() => shown.value?.edges ?? [])
const hasRelations = computed(() => (graph.value?.edges.length ?? 0) > 0)

async function load() {
  error.value = null
  graph.value = null
  try {
    graph.value = await fetchApi(queryClient, '/v1/documents/{id}/graph', {
      path: { id: props.documentId },
      query: { depth: String(depth.value) },
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function open(id: string) {
  if (id !== props.documentId) void router.push(`/documents/${id}`)
}

onMounted(() => {
  void load()
  void graphTime?.loadTimeline()
})
watch(depth, () => {
  void load()
  graphTime?.refresh()
})
watch(() => props.documentId, () => void load())
onBeforeUnmount(() => { graph.value = null })
</script>

<template>
  <!-- Maximized: the canvas owns the frame, and the depth selector rides in the
       lightbox header rather than stealing a row from the graph. -->
  <div v-if="variant === 'full'" class="flex size-full flex-col">
    <div class="flex items-center gap-2 border-b px-3 py-2">
      <Label for="graph-depth-full" class="text-xs font-normal text-muted-foreground">{{ t('graph.depth') }}</Label>
      <Select v-model="depth">
        <SelectTrigger id="graph-depth-full" size="sm" class="h-7 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="d in [1, 2, 3]" :key="d" :value="d">{{ t('graph.hops', { n: d }, d) }}</SelectItem>
        </SelectContent>
      </Select>
      <p v-if="error" class="truncate text-xs text-destructive">{{ error }}</p>
    </div>
    <div class="relative min-h-0 flex-1">
      <GraphCanvas
        v-if="graph"
        :nodes="nodes"
        :edges="edges"
        :root-id="documentId"
        :time="graphTime"
        storage-key="kn_graph_opts_page"
        @open="open"
      />
      <div v-else class="grid size-full place-items-center">
        <Skeleton class="size-full" />
      </div>
    </div>
  </div>

  <!-- In the rail: depth, a one-line count, and the graph. -->
  <div v-else class="space-y-2.5">
    <div class="flex items-center gap-2">
      <Label for="graph-depth" class="text-xs font-normal text-muted-foreground">{{ t('graph.depth') }}</Label>
      <Select v-model="depth">
        <SelectTrigger id="graph-depth" size="sm" class="h-7 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="d in [1, 2, 3]" :key="d" :value="d">{{ t('graph.hops', { n: d }, d) }}</SelectItem>
        </SelectContent>
      </Select>
      <span v-if="graph && hasRelations" class="ml-auto truncate text-xs text-muted-foreground">
        {{ t('graph.countNodes', { n: stats.nodes }, stats.nodes) }} ·
        {{ t('graph.countLinks', { n: stats.edges }, stats.edges) }}
      </span>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <Skeleton v-else-if="!graph" class="h-64 w-full rounded-lg" />
    <p v-else-if="!hasRelations" class="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      {{ t('graph.noRelations', { code: 'relations:' }) }}
    </p>
    <div v-else class="h-64 overflow-hidden rounded-lg border bg-background">
      <KnowledgeGraph
        :nodes="nodes"
        :edges="edges"
        :root-id="documentId"
        :options="railOptions"
        density="compact"
        @open="open"
        @stats="stats = { nodes: $event.nodes, edges: $event.edges }"
      />
    </div>
  </div>
</template>
