<script setup lang="ts">
/**
 * The pages landing.
 *
 * A knowledge base's index used to be a tree, which answers "where does this
 * page live" and nothing else. But containment is the least interesting thing
 * about a store whose whole premise is typed relations with provenance: the
 * questions people actually arrive with are which pages are load-bearing, what
 * clusters around what, and what nothing points at. A graph answers all three
 * at a glance and a tree answers none of them.
 *
 * So the graph leads and the tree stays. It stays because PRODUCT.md is
 * explicit that the graph must never be the only route to a piece of
 * information, and because "show me everything alphabetically" is a real
 * question a force layout is bad at. The switcher is the whole compromise, and
 * the choice sticks.
 *
 * All three views take the full width. This is an index, not prose: the measure
 * rule protects reading, and a column of titles centred in a wide window just
 * wastes the room the graph needs and the list can use.
 */
import { computed, onMounted, onServerPrefetch, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { FileText, List, ListTree, Loader2, Network, Plus, SlidersHorizontal, Upload, X } from 'lucide-vue-next'
import { formatDate } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { useAuthStore } from '@/stores/auth'
import { EMPTY_FILTERS, useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { statusDot, statusVariant } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import DocumentTreeNode from '@/components/knowledge/DocumentTreeNode.vue'
import DocumentFacets from '@/components/knowledge/DocumentFacets.vue'
import GraphCanvas from '@/components/graph/GraphCanvas.vue'
import { toGraphNodes } from '@/components/graph/graph-model'

const { t } = useI18n()

const auth = useAuthStore()
const store = useDocumentsStore()
const projects = useProjectsStore()
const router = useRouter()

type View = 'graph' | 'tree' | 'list'
const VIEW_KEY = 'kn_docs_view'
const VIEWS = [
  { id: 'graph' as const, icon: Network, label: 'documents.viewGraph' },
  { id: 'tree' as const, icon: ListTree, label: 'documents.viewTree' },
  { id: 'list' as const, icon: List, label: 'documents.viewList' },
]

/**
 * Starts on the graph for SSR *and* the first client render, then adopts the
 * stored preference after hydration. Reading storage during setup would make
 * the server and client markup disagree, and the graph is a canvas the server
 * cannot draw anyway — so the one frame this costs is a frame that was always
 * going to be a placeholder.
 */
const view = ref<View>('graph')

/**
 * The facets rail. Offered on the list only: they filter *which documents*,
 * which a flat list can express and a hierarchy cannot — filtering a tree by
 * category leaves branches hanging off parents that were filtered out. The
 * graph has its own instrument panel, for its own kind of filtering.
 */
const filtersOpen = ref(false)
const showFilters = computed(() => view.value === 'list')

function setFacet(key: 'categories' | 'projectIds' | 'tags', value: string[]) {
  void store.setFilters({ ...store.filters, [key]: value } as typeof store.filters)
}
function clearFacets() {
  void store.setFilters({ ...EMPTY_FILTERS })
}

const scopeLabel = computed(() =>
  projects.activeName
    ? t('documents.scopeProject', { name: projects.activeName })
    : t('documents.scopeWorkspace'),
)

onServerPrefetch(() => Promise.all([store.fetchTree(), store.fetchList({ reset: true })]))
onMounted(() => {
  try {
    const stored = localStorage.getItem(VIEW_KEY) as View | null
    if (stored && VIEWS.some((v) => v.id === stored)) view.value = stored
  } catch {
    /* private mode */
  }
  if (!store.treeLoaded) void store.fetchTree()
  if (!store.loaded) void store.fetchList({ reset: true })
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
})

function setView(next: View) {
  view.value = next
  try { localStorage.setItem(VIEW_KEY, next) } catch { /* private mode */ }
}

// The graph is fetched the first time it is actually shown: it is the heaviest
// of the three payloads, and a reader who lives in the tree should never pay
// for it.
watch(
  [view, () => projects.activeId],
  () => { if (view.value === 'graph' && !store.graphLoaded) void store.fetchGraph() },
  { immediate: true },
)

const graphNodes = computed(() => toGraphNodes(store.graph?.nodes ?? []))
const graphEdges = computed(() => store.graph?.edges ?? [])
const hasEntities = computed(() => graphNodes.value.some((n) => n.kind === 'entity'))

const isEmpty = computed(() => store.treeLoaded && store.tree.length === 0)

/* ------------------------------------------------------ virtualized list */

const ROW_HEIGHT = 36
const scrollEl = ref<HTMLElement | null>(null)

/**
 * Rows are uniform and the count is unbounded, which is exactly the case
 * virtualization is for: a workspace of ten thousand pages renders the forty
 * that are on screen. A trailing sentinel row carries the loading state, so
 * "there is more" is a row in the list rather than an overlay floating over it.
 */
const rowCount = computed(() => store.items.length + (store.hasMore ? 1 : 0))

const virtualizer = useVirtualizer(
  computed(() => {
    // Read through the ref here, not inside getScrollElement — the scroller is
    // only found on mount, and unless the options recompute when it lands the
    // virtualizer stays attached to nothing and renders an empty window.
    const scroller = scrollEl.value
    return {
      count: rowCount.value,
      getScrollElement: () => scroller,
      estimateSize: () => ROW_HEIGHT,
      overscan: 12,
      getItemKey: (index: number) => store.items[index]?.documentId ?? `sentinel-${index}`,
    }
  }),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

/**
 * Fetch when the window reaches the last screenful, not when the sentinel is
 * actually visible: waiting for it means the reader watches a spinner they
 * scrolled to, instead of the rows simply continuing.
 */
watch(virtualRows, (rows) => {
  const last = rows[rows.length - 1]
  if (!last) return
  if (last.index >= store.items.length - 12) void store.loadMore()
})
</script>

<template>
  <!-- meta.fill: the graph is a canvas that must resolve a definite height, so
       this route owns the viewport and scrolls the tree/list inside itself
       rather than growing the page. -->
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3 lg:px-6">
      <div class="min-w-0">
        <h1 class="font-display text-xl font-bold leading-tight tracking-tight">{{ t('documents.title') }}</h1>
        <p v-if="store.loaded" class="truncate text-xs text-muted-foreground">
          {{ t('documents.pageCount', { count: store.items.length, scope: scopeLabel }, store.items.length) }}
        </p>
      </div>

      <!-- Segmented, not pill-shaped: a control in this system is 8px-squared,
           and roundness is reserved for counts and identities. -->
      <div class="ml-auto flex overflow-hidden rounded-md border bg-card p-0.5" role="tablist" :aria-label="t('documents.view')">
        <button
          v-for="v in VIEWS"
          :key="v.id"
          role="tab"
          :aria-selected="view === v.id"
          class="flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          :class="view === v.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
          @click="setView(v.id)"
        >
          <component :is="v.icon" class="size-3.5" />
          <span class="hidden sm:inline">{{ t(v.label) }}</span>
        </button>
      </div>

      <Button
        v-if="showFilters"
        variant="outline"
        size="sm"
        :aria-pressed="filtersOpen"
        :class="filtersOpen ? 'border-primary/40 bg-primary/10 text-primary' : ''"
        @click="filtersOpen = !filtersOpen"
      >
        <SlidersHorizontal class="size-4" />
        <span class="hidden sm:inline">{{ t('graph.filters') }}</span>
        <span
          v-if="store.activeFilterCount"
          class="grid size-4 place-items-center rounded-full bg-primary text-[0.625rem] font-semibold text-primary-foreground"
        >{{ store.activeFilterCount }}</span>
      </Button>

      <div v-if="auth.canEdit" class="flex gap-2">
        <Button variant="outline" size="sm" as-child>
          <RouterLink to="/upload"><Upload class="size-4" /> <span class="hidden sm:inline">{{ t('documents.upload') }}</span></RouterLink>
        </Button>
        <Button size="sm" as-child>
          <RouterLink to="/create"><Plus class="size-4" /> <span class="hidden sm:inline">{{ t('documents.newPage') }}</span></RouterLink>
        </Button>
      </div>
    </header>

    <!-- The rail sits beside the view, so the content reflows into the room it
         leaves rather than being covered by it — the same arrangement, and the
         same two-element mechanism, as the shell's navigation rail. -->
    <div class="relative flex min-h-0 flex-1 overflow-hidden" :data-filters-open="filtersOpen && showFilters">
      <div class="relative min-w-0 flex-1">
        <!-- Nothing published yet: the same empty state whatever the view, since
             an empty graph and an empty tree are the same problem. -->
        <div v-if="isEmpty" class="grid size-full place-items-center px-6 text-center">
          <div>
            <FileText class="mx-auto size-8 text-muted-foreground/50" />
            <p class="mt-3 font-medium">{{ t('documents.noPagesYet') }}</p>
            <p class="mt-1 text-sm text-muted-foreground">
              {{ auth.canEdit ? t('documents.createFirst', { scope: scopeLabel }) : t('documents.nothingPublished', { scope: scopeLabel }) }}
            </p>
            <Button v-if="auth.canEdit" class="mt-4" as-child>
              <RouterLink to="/create"><Plus class="size-4" /> {{ t('documents.newPage') }}</RouterLink>
            </Button>
          </div>
        </div>

        <!-- Graph ---------------------------------------------------------->
        <template v-else-if="view === 'graph'">
          <GraphCanvas
            v-if="store.graphLoaded && store.graph"
            :nodes="graphNodes"
            :edges="graphEdges"
            :truncated="store.graph.truncated"
            :show-entity-controls="hasEntities"
            storage-key="kn_graph_opts_workspace"
            @open="(id) => router.push(`/documents/${id}`)"
          />
          <div v-else class="grid size-full place-items-center">
            <Skeleton class="size-full" />
          </div>
        </template>

        <!-- Tree ----------------------------------------------------------->
        <div v-else-if="view === 'tree'" class="h-full overflow-y-auto px-2 py-3 lg:px-4">
          <div v-if="!store.treeLoaded" class="space-y-2 px-2">
            <Skeleton v-for="i in 8" :key="i" class="h-8 w-full" />
          </div>
          <template v-else>
            <DocumentTreeNode
              v-for="node in store.tree"
              :key="node.documentId"
              :node="node"
              :depth="0"
            />
          </template>
        </div>

        <!-- List ----------------------------------------------------------->
        <div v-else ref="scrollEl" class="h-full overflow-y-auto px-2 py-3 lg:px-4">
          <div v-if="!store.loaded" class="space-y-2 px-2">
            <Skeleton v-for="i in 10" :key="i" class="h-8 w-full" />
          </div>
          <p v-else-if="store.items.length === 0" class="px-3 py-6 text-sm text-muted-foreground">
            {{ store.activeFilterCount ? t('documents.noPagesForFilters') : t('documents.noPagesInCategory') }}
          </p>
          <!-- One spacer sized to the whole list, with only the visible window
               rendered inside it. Rows are uniform, so nothing needs measuring
               and the scrollbar is honest from the first frame. -->
          <div v-else class="relative w-full" :style="{ height: `${totalSize}px` }">
            <div
              v-for="row in virtualRows"
              :key="String(row.key)"
              class="absolute inset-x-0 top-0"
              :style="{ height: `${row.size}px`, transform: `translateY(${row.start}px)` }"
            >
              <RouterLink
                v-if="store.items[row.index]"
                :to="`/documents/${store.items[row.index]!.documentId}`"
                class="flex h-full items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted/60"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="statusDot(store.items[row.index]!.headRevisionStatus)"
                  :title="store.items[row.index]!.headRevisionStatus ?? 'draft'"
                />
                <span class="truncate text-sm font-medium">{{ store.items[row.index]!.title }}</span>
                <Badge variant="outline" class="hidden shrink-0 text-xs sm:inline-flex">
                  {{ labelFor(t, 'category', store.items[row.index]!.category) }}
                </Badge>
                <Badge
                  :variant="statusVariant(store.items[row.index]!.headRevisionStatus)"
                  class="hidden shrink-0 text-xs sm:inline-flex"
                >
                  {{ store.items[row.index]!.headRevisionStatus ?? 'draft' }}
                </Badge>
                <span class="ml-auto shrink-0 text-xs text-muted-foreground">
                  {{ formatDate(store.items[row.index]!.createdAt) }}
                </span>
              </RouterLink>
              <!-- The sentinel: "more is coming" as a row in the list rather
                   than a spinner floating over it. -->
              <div v-else class="flex h-full items-center gap-2 px-2 text-xs text-muted-foreground">
                <Loader2 class="size-3.5 animate-spin" />
                {{ t('common.loading') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Filters rail --------------------------------------------------->
      <template v-if="showFilters">
        <div class="kn-filters-gap shrink-0" aria-hidden="true" />
        <aside
          class="kn-filters absolute inset-y-0 right-0 z-20 flex flex-col border-l bg-card"
          :aria-hidden="!filtersOpen"
          :inert="!filtersOpen || undefined"
        >
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <span class="text-sm font-medium">{{ t('graph.filters') }}</span>
            <button
              v-if="store.activeFilterCount"
              class="ml-auto text-xs text-primary hover:underline"
              @click="clearFacets"
            >
              {{ t('common.clear') }}
            </button>
            <button
              class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              :class="store.activeFilterCount ? '' : 'ml-auto'"
              :aria-label="t('common.close')"
              @click="filtersOpen = false"
            >
              <X class="size-3.5" />
            </button>
          </div>
          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
            <DocumentFacets
              :projects="store.filters.projectIds"
              :categories="store.filters.categories"
              :tags="store.filters.tags"
              @update:projects="setFacet('projectIds', $event)"
              @update:categories="setFacet('categories', $event)"
              @update:tags="setFacet('tags', $event)"
            />
          </div>
        </aside>
      </template>
    </div>
  </div>
</template>
