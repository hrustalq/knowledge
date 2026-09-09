<script setup lang="ts">
/**
 * The graph as a full surface: canvas, instrument panel, framing controls and
 * the one line of counts that says how much you are looking at.
 *
 * One component serves the pages landing and the maximized view, because they
 * are the same surface at two sizes — anything that behaved differently in the
 * lightbox would be a second thing to keep correct.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus, Scan } from 'lucide-vue-next'
import KnowledgeGraph from './KnowledgeGraph.vue'
import GraphControls from './GraphControls.vue'
import { DEFAULT_OPTIONS, type GraphEdgeInput, type GraphNodeInput, type GraphOptions } from './graph-model'

const props = withDefaults(
  defineProps<{
    nodes: GraphNodeInput[]
    edges: GraphEdgeInput[]
    rootId?: string | null
    /** Truncation is reported, never silent: a partial graph that says nothing
        looks exactly like a small one. */
    truncated?: boolean
    showEntityControls?: boolean
    storageKey?: string
  }>(),
  { rootId: null, truncated: false, showEntityControls: true, storageKey: '' },
)

const emit = defineEmits<{ open: [id: string] }>()

const { t } = useI18n()

function restore(): GraphOptions {
  if (!props.storageKey || typeof localStorage === 'undefined') return { ...DEFAULT_OPTIONS }
  try {
    const raw = localStorage.getItem(props.storageKey)
    return raw ? { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<GraphOptions>) } : { ...DEFAULT_OPTIONS }
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

const options = ref<GraphOptions>(restore())
const query = ref('')
const stats = ref({ nodes: 0, edges: 0, orphans: 0, counts: {} as Record<string, number> })
const graph = ref<InstanceType<typeof KnowledgeGraph> | null>(null)

watch(
  options,
  (v) => {
    if (!props.storageKey || typeof localStorage === 'undefined') return
    try { localStorage.setItem(props.storageKey, JSON.stringify(v)) } catch { /* private mode */ }
  },
  { deep: true },
)

const summary = computed(() =>
  [
    t('graph.countNodes', { n: stats.value.nodes }, stats.value.nodes),
    t('graph.countLinks', { n: stats.value.edges }, stats.value.edges),
  ].join(' · '),
)
</script>

<template>
  <div class="relative size-full overflow-hidden bg-background">
    <KnowledgeGraph
      ref="graph"
      :nodes="nodes"
      :edges="edges"
      :root-id="rootId"
      :options="options"
      :query="query"
      :inset-left="264"
      @open="emit('open', $event)"
      @stats="stats = $event"
    />

    <!-- The wrapper does not take the pointer, so the reader can start a drag
         in the gap beside the panel and pan from anywhere that looks empty. -->
    <div class="pointer-events-none absolute inset-0 p-3">
      <div class="flex h-full items-start justify-between gap-3">
        <GraphControls
          v-model:options="options"
          v-model:query="query"
          :counts="stats.counts"
          :orphans="stats.orphans"
          :show-entity-controls="showEntityControls"
          class="max-h-full overflow-y-auto"
        />
        <div class="pointer-events-auto"><slot name="actions" /></div>
      </div>

      <div class="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
        <p class="rounded-md bg-background/70 px-1.5 py-0.5 text-xs text-muted-foreground backdrop-blur-sm">
          {{ summary }}
          <span v-if="truncated" class="text-amber-600 dark:text-amber-500"> · {{ t('graph.truncated') }}</span>
        </p>
        <div class="pointer-events-auto flex overflow-hidden rounded-lg border bg-card/90 shadow-xs backdrop-blur-md">
          <button class="kn-graph-btn" :title="t('graph.zoomOut')" :aria-label="t('graph.zoomOut')" @click="graph?.zoomBy(0.75)">
            <Minus class="size-4" />
          </button>
          <button class="kn-graph-btn border-x" :title="t('graph.fitToView')" :aria-label="t('graph.fitToView')" @click="graph?.fit()">
            <Scan class="size-4" />
          </button>
          <button class="kn-graph-btn" :title="t('graph.zoomIn')" :aria-label="t('graph.zoomIn')" @click="graph?.zoomBy(1.333)">
            <Plus class="size-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
