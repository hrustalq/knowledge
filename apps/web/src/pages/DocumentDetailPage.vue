<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Pencil } from 'lucide-vue-next'
import type {
  DocumentContentResponse,
  DocumentDetailResponse,
  ListDocumentRelationsResponse,
} from '@knowledge/contracts'
import { apiFetch, statusVariant } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useEventsStore } from '@/stores/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import TocRail from '@/components/knowledge/TocRail.vue'
import RevisionsView from '@/components/knowledge/RevisionsView.vue'
import GraphView from '@/components/knowledge/GraphView.vue'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
import AskAssistant from '@/components/knowledge/AskAssistant.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useDocumentsStore()
const events = useEventsStore()

const TABS = ['overview', 'content', 'revisions', 'graph', 'activity'] as const
type Tab = (typeof TABS)[number]

const documentId = computed(() => route.params.id as string)
const tab = computed<Tab>(() =>
  TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'overview',
)

const detail = ref<DocumentDetailResponse | null>(null)
const content = ref<DocumentContentResponse | null>(null)
const contentError = ref<string | null>(null)
const relations = ref<ListDocumentRelationsResponse['relations'] | null>(null)
const error = ref<string | null>(null)
const headings = ref<{ id: string; text: string; level: number }[]>([])
let timer: ReturnType<typeof setInterval> | undefined

function setTab(next: Tab) {
  void router.replace({ query: { ...route.query, tab: next === 'overview' ? undefined : next } })
}

async function load() {
  try {
    detail.value = await apiFetch<DocumentDetailResponse>(`/v1/documents/${documentId.value}`)
    const status = detail.value.revision.status
    if (status === 'indexed' || status === 'failed' || status === 'draft') {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  } catch (e) {
    error.value = (e as Error).message
    if (timer) clearInterval(timer)
  }
}

async function loadContent() {
  contentError.value = null
  content.value = null
  headings.value = []
  try {
    const rev = route.query.revision ? `?revision=${route.query.revision as string}` : ''
    content.value = await apiFetch<DocumentContentResponse>(`/v1/documents/${documentId.value}/content${rev}`)
  } catch (e) {
    contentError.value = (e as Error).message
  }
}

async function loadRelations() {
  try {
    const res = await apiFetch<ListDocumentRelationsResponse>(`/v1/documents/${documentId.value}/relations`)
    relations.value = res.relations
  } catch {
    relations.value = []
  }
}

onMounted(() => {
  void load()
  void loadRelations()
  if (!store.treeLoaded) void store.fetchTree()
  timer = setInterval(() => void load(), 2000)
  if (tab.value === 'content') void loadContent()
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

watch([tab, () => route.query.revision], () => {
  if (tab.value === 'content') void loadContent()
})
// Route reuse: navigating to a different document keeps this component alive.
watch(documentId, () => {
  detail.value = null
  content.value = null
  relations.value = null
  error.value = null
  headings.value = []
  if (timer) clearInterval(timer)
  timer = setInterval(() => void load(), 2000)
  void load()
  void loadRelations()
  if (tab.value === 'content') void loadContent()
})
// Feature 04: live refresh when this document is re-indexed elsewhere.
watch(
  () => events.lastEvent,
  (e) => {
    if (e && e.documentId === documentId.value && e.type.startsWith('revision.')) {
      void load()
      void loadRelations()
      if (tab.value === 'content') void loadContent()
    }
  },
)
</script>

<template>
  <p v-if="error" class="text-destructive">{{ error }}</p>

  <div v-else-if="!detail" class="space-y-2">
    <Skeleton class="h-8 w-1/2" />
    <Skeleton class="h-40 w-full" />
  </div>

  <div v-else class="space-y-4">
    <header class="space-y-2">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ detail.document.title }}</h1>
        <Badge variant="outline">{{ detail.document.category }}</Badge>
        <Badge :variant="statusVariant(detail.revision.status)">{{ detail.revision.status }}</Badge>
        <Button v-if="auth.canEdit" variant="outline" size="sm" class="ml-auto" as-child>
          <RouterLink :to="`/documents/${detail.document.documentId}/edit`">
            <Pencil class="size-3.5" />
            Edit
          </RouterLink>
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Revision #{{ detail.revision.revisionNumber }}
        <span class="font-mono">({{ detail.revision.revisionId.slice(0, 8) }})</span>
        <template v-if="detail.revision.finalizedAt">
          · finalized {{ new Date(detail.revision.finalizedAt).toLocaleString() }}
        </template>
      </p>
    </header>

    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="t in TABS"
        :key="t"
        role="tab"
        :aria-selected="tab === t"
        class="whitespace-nowrap border-b-2 px-3 py-2 text-sm capitalize transition-colors"
        :class="tab === t
          ? 'border-primary font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="setTab(t)"
      >
        {{ t }}
      </button>
    </div>

    <!-- Overview -->
    <div v-if="tab === 'overview'" class="space-y-4">
      <Card>
        <CardHeader><CardTitle>Revision</CardTitle></CardHeader>
        <CardContent class="grid grid-cols-2 gap-2 text-sm">
          <span class="text-muted-foreground">Revision</span>
          <span>#{{ detail.revision.revisionNumber }} ({{ detail.revision.revisionId.slice(0, 8) }})</span>
          <span class="text-muted-foreground">Content type</span>
          <span>{{ detail.revision.contentType }}</span>
          <span class="text-muted-foreground">Content hash</span>
          <span class="truncate font-mono text-xs">{{ detail.revision.contentHash ?? '—' }}</span>
          <span class="text-muted-foreground">Finalized</span>
          <span>{{ detail.revision.finalizedAt ? new Date(detail.revision.finalizedAt).toLocaleString() : '—' }}</span>
        </CardContent>
      </Card>

      <Card v-if="relations && relations.length > 0">
        <CardHeader><CardTitle>Relations ({{ relations.length }})</CardTitle></CardHeader>
        <CardContent class="space-y-1.5">
          <div v-for="(r, i) in relations" :key="i" class="flex flex-wrap items-baseline gap-2 text-sm">
            <Badge variant="secondary" class="text-xs">{{ r.type }}</Badge>
            <span class="font-medium">{{ r.to.name }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ r.to.key }}</span>
            <span class="ml-auto text-xs text-muted-foreground">
              {{ r.provenance.extractor }} · {{ r.provenance.confidence }}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card v-if="detail.chunks.length > 0">
        <CardHeader><CardTitle>Chunks ({{ detail.chunks.length }})</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <div v-for="chunk in detail.chunks" :key="chunk.chunkId" class="rounded-md border p-3">
            <p v-if="chunk.headingPath.length" class="mb-1 text-xs font-medium text-muted-foreground">
              {{ chunk.headingPath.join(' › ') }}
            </p>
            <p class="text-sm">{{ chunk.snippet }}…</p>
          </div>
        </CardContent>
      </Card>

      <p v-else-if="detail.revision.status !== 'indexed'" class="text-sm text-muted-foreground">
        Chunks appear here once ingestion completes.
      </p>
    </div>

    <!-- Content (feature 01) with "On this page" rail -->
    <div v-else-if="tab === 'content'" class="flex items-start gap-8">
      <div class="min-w-0 max-w-3xl flex-1 space-y-4">
        <p v-if="contentError" class="text-sm text-destructive">{{ contentError }}</p>
        <Skeleton v-else-if="!content" class="h-64 w-full" />
        <template v-else>
          <p v-if="route.query.revision" class="text-xs text-muted-foreground">
            Viewing revision {{ (route.query.revision as string).slice(0, 8) }} —
            <RouterLink :to="`/documents/${documentId}?tab=content`" class="underline">back to head</RouterLink>
          </p>
          <details v-if="content.frontmatter" class="rounded-lg border bg-card">
            <summary class="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-muted-foreground">
              Frontmatter
            </summary>
            <pre class="overflow-x-auto border-t bg-muted/40 p-3 text-xs">{{ JSON.stringify(content.frontmatter, null, 2) }}</pre>
          </details>
          <MarkdownView :markdown="content.markdown" @headings="headings = $event" />
        </template>
      </div>
      <aside v-if="headings.length > 1" class="sticky top-6 ml-auto hidden w-52 shrink-0 xl:block">
        <TocRail :headings="headings" />
      </aside>
    </div>

    <!-- Revisions (feature 05) -->
    <RevisionsView v-else-if="tab === 'revisions'" :document-id="documentId" />

    <!-- Graph (feature 06) -->
    <GraphView v-else-if="tab === 'graph'" :document-id="documentId" />

    <!-- Activity (feature 10) -->
    <ActivityFeed v-else-if="tab === 'activity'" :document-id="documentId" />

    <!-- Ask-AI chat about this page -->
    <AskAssistant :document-id="documentId" :title="detail.document.title" />
  </div>
</template>
