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
import { useRouter } from 'vue-router'
import type { DocumentGraphResponse } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import KnowledgeGraph from '@/components/graph/KnowledgeGraph.vue'
import GraphCanvas from '@/components/graph/GraphCanvas.vue'
import { DEFAULT_OPTIONS, type GraphNodeInput } from '@/components/graph/graph-model'

const props = withDefaults(
  defineProps<{ documentId: string; variant?: 'rail' | 'full' }>(),
  { variant: 'rail' },
)

const { t } = useI18n()
const router = useRouter()

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

const nodes = computed<GraphNodeInput[]>(() =>
  (graph.value?.nodes ?? []).map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    category: n.category,
    entityType: n.entityType,
    distance: n.distance,
  })),
)
const edges = computed(() => graph.value?.edges ?? [])
const hasRelations = computed(() => (graph.value?.edges.length ?? 0) > 0)

async function load() {
  error.value = null
  graph.value = null
  try {
    graph.value = await apiFetch<DocumentGraphResponse>(
      `/v1/documents/${props.documentId}/graph?depth=${depth.value}`,
    )
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function open(id: string) {
  if (id !== props.documentId) void router.push(`/documents/${id}`)
}

onMounted(() => void load())
watch(depth, () => void load())
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
