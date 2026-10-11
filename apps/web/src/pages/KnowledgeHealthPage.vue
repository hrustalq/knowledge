<script setup lang="ts">
/**
 * Knowledge health (docs/features/40, issue #66 phase 6): the workspace-wide
 * read side of page verification. Which pages are stale, unowned, empty or
 * put away, the counts, one action over many of them, and the policy that
 * decides what those words mean.
 *
 * Two tabs: **Pages** — the preset strip (each a `HealthFilter`, with its live
 * count), the narrowing row, the table and the bulk bar — and **Settings**,
 * the freshness policy. `?tab=` and `?filter=` are opening instructions: a
 * notification or a doc can point at "the unowned pages", and the page starts
 * there.
 *
 * Every narrowing goes to the server; the counts and the rows come from the
 * same CTE and so always agree. The list continues with "Load more" — a sweep
 * is read top to bottom, most neglected first, and a scrolling window would
 * fight the selection.
 *
 * Scope follows the active project, as the pages index does: the switcher in
 * the rail is where "which project" is answered, not a second control here.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type {
  KnowledgeHealthBulkResponse,
  KnowledgeHealthListResponse,
  KnowledgeHealthRow,
  KnowledgeHealthSummaryResponse,
} from '@knowledge/contracts'
import { apiMutationOptions, apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { PageLayout, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/components/layout/page'
import HealthBulkBar from '@/components/health/HealthBulkBar.vue'
import HealthFilters from '@/components/health/HealthFilters.vue'
import HealthPreviewSheet from '@/components/health/HealthPreviewSheet.vue'
import HealthSettings from '@/components/health/HealthSettings.vue'
import HealthTable from '@/components/health/HealthTable.vue'
import {
  EMPTY_SELECTION,
  clearSelection,
  prune,
  selectRow,
  toggleAll,
  type HealthSelection,
  type SelectModifiers,
} from '@/components/health/health-selection'
import {
  HEALTH_PAGE,
  HEALTH_PRESETS,
  isHealthPreset,
  type HealthBulkRequest,
  type HealthPreset,
  type HealthSort,
} from '@/components/health/health-ui'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const queryClient = useQueryClient()

const workspaceId = getWorkspaceId()
const projectId = getProjectId() ?? undefined

/* ------------------------------------------------------------------ tabs */

type TabKey = 'pages' | 'settings'
const tabs = computed<PageTab<TabKey>[]>(() => [
  { key: 'pages', label: t('health.tab.pages') },
  { key: 'settings', label: t('health.tab.settings') },
])
const tab = usePageTabs(tabs, 'pages')

/* --------------------------------------------------------------- presets */

/**
 * `?filter=` is read the way `?tab=` is: on arrival, and written back with
 * `replace` so Back does not walk every preset tried on the way.
 */
const preset = computed<HealthPreset>({
  get: () => (isHealthPreset(route.query.filter) ? route.query.filter : 'all'),
  set(next) {
    const query = { ...route.query }
    if (next === 'all') delete query.filter
    else query.filter = next
    void router.replace({ query })
  },
})

const summaryQuery = useQuery(
  apiQueryOptions('/v1/knowledge-health/summary', { query: { workspaceId, ...(projectId ? { projectId } : {}) } }),
)
const summary = computed(() => summaryQuery.data.value as KnowledgeHealthSummaryResponse | undefined)

/** The counts are `null` until the summary lands: "0" would be a claim. */
function countFor(p: HealthPreset): number | null {
  const s = summary.value
  if (!s) return null
  return p === 'all' ? s.total : s.counts[p]
}

/* ------------------------------------------------------------- narrowing */

const q = ref('')
const ownerId = ref<string | null>(null)
const sort = ref<HealthSort>('activity')
const cursor = ref<string | undefined>(undefined)
/** Accumulated previous pages (reset when the narrowing changes). */
const older = ref<KnowledgeHealthRow[]>([])

const listParams = computed(() => ({
  workspaceId,
  ...(projectId ? { projectId } : {}),
  ...(preset.value !== 'all' ? { filter: preset.value } : {}),
  ...(ownerId.value ? { ownerId: ownerId.value } : {}),
  ...(q.value ? { q: q.value } : {}),
  sort: sort.value,
  limit: HEALTH_PAGE,
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

watch([preset, q, ownerId, sort], () => resetPaging())

const listQuery = useQuery(computed(() => apiQueryOptions('/v1/knowledge-health', { query: listParams.value })))
const page = computed(() => listQuery.data.value as KnowledgeHealthListResponse | undefined)
const rows = computed(() => [...older.value, ...(page.value?.rows ?? [])])

const narrowed = computed(() => preset.value !== 'all' || q.value !== '' || ownerId.value !== null)

function resetPaging() {
  cursor.value = undefined
  older.value = []
}
function loadMore() {
  if (!page.value?.nextCursor) return
  older.value = rows.value
  cursor.value = page.value.nextCursor
}
function clearNarrowing() {
  preset.value = 'all'
  q.value = ''
  ownerId.value = null
}

const scopeLabel = computed(() =>
  projects.activeName ? t('documents.scopeProject', { name: projects.activeName }) : t('documents.scopeWorkspace'),
)
const subtitle = computed(() => {
  const total = summary.value?.total
  return total === undefined
    ? t('health.subtitleIntro')
    : t('health.subtitle', { count: total, scope: scopeLabel.value }, total)
})

/* ------------------------------------------------------------- selection */

const canSelect = computed(() => auth.canEdit)
const selection = ref<HealthSelection>(EMPTY_SELECTION)
const order = computed(() => rows.value.map((r) => r.documentId))

// Rows change under the selection (a preset switch, a refetch after a sweep):
// a page no longer drawn is no longer selected.
watch(order, (ids) => {
  selection.value = prune(selection.value, ids)
})

function onSelect(id: string, modifiers: SelectModifiers) {
  selection.value = selectRow(selection.value, id, order.value, modifiers)
}
function onToggleAll() {
  selection.value = toggleAll(selection.value, order.value)
}
function onClear() {
  selection.value = clearSelection()
}

/** Escape clears the selection — unless the reader is typing somewhere. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || selection.value.ids.size === 0) return
  const target = event.target
  if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
  onClear()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/* ------------------------------------------------------------------ bulk */

const bulk = useMutation(apiMutationOptions('post', '/v1/knowledge-health/bulk'))

/** The reason a page refused, in words; the codes are the API's (`archived`, `no-head`, `not-found`). */
function reasonFor(code: string | undefined): string {
  const known = ['archived', 'no-head', 'not-found']
  return t(`health.bulk.reason.${code && known.includes(code) ? code : 'unknown'}`)
}

/** How many failures get a toast of their own before the rest are counted. */
const FAILURE_TOASTS = 5

async function runBulk(request: HealthBulkRequest) {
  const ids = [...selection.value.ids]
  if (ids.length === 0 || bulk.isPending.value) return
  const titles = new Map(rows.value.map((r) => [r.documentId, r.title]))
  try {
    const res = (await bulk.mutateAsync({ body: { workspaceId, documentIds: ids, ...request } })) as KnowledgeHealthBulkResponse
    const failed = res.results.filter((r) => !r.ok)
    const ok = res.results.length - failed.length
    if (ok > 0) toast.success(t(`health.toast.${res.action}`, { n: ok }, ok))
    for (const f of failed.slice(0, FAILURE_TOASTS)) {
      toast.error(t('health.bulk.failed', { title: titles.get(f.documentId) ?? f.documentId.slice(0, 8), reason: reasonFor(f.error) }))
    }
    const rest = failed.length - FAILURE_TOASTS
    if (rest > 0) toast.error(t('health.bulk.failedMore', { n: rest }, rest))
    onClear()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    // The server truth wins either way: rows may have left this preset, and
    // the counts on the strip have moved.
    void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-health'] })
    void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-health/summary'] })
  }
}

/* --------------------------------------------------------------- preview */

const previewRow = ref<KnowledgeHealthRow | null>(null)
</script>

<template>
  <PageLayout variant="list" :title="t('health.title')" :subtitle="subtitle">
    <template #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('health.title')" />
    </template>

    <div v-if="tab === 'pages'" :id="panelId('pages')" role="tabpanel" :aria-labelledby="tabId('pages')" class="flex min-w-0 flex-col gap-4">
      <!-- The presets. Each is a filter the API knows, with its live count, so
           the strip is the summary and the summary is the strip. -->
      <div class="flex flex-wrap gap-1.5" role="group" :aria-label="t('health.presets')">
        <button
          v-for="p in HEALTH_PRESETS"
          :key="p"
          type="button"
          class="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          :class="preset === p
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'"
          :aria-pressed="preset === p"
          :title="t(`health.presetHint.${p}`)"
          @click="preset = p"
        >
          {{ t(`health.preset.${p}`) }}
          <span v-if="countFor(p) !== null" class="tabular-nums opacity-70">{{ countFor(p) }}</span>
        </button>
      </div>

      <HealthFilters v-model:q="q" v-model:owner-id="ownerId" v-model:sort="sort" />

      <HealthBulkBar
        v-if="selection.ids.size > 0"
        :count="selection.ids.size"
        :busy="bulk.isPending.value"
        :can-archive="auth.canAdminWorkspace"
        @run="runBulk"
        @clear="onClear"
      />

      <HealthTable
        :rows="rows"
        :selection="selection"
        :loading="listQuery.isPending.value && rows.length === 0"
        :narrowed="narrowed"
        :can-select="canSelect"
        @select="onSelect"
        @toggle-all="onToggleAll"
        @preview="previewRow = $event"
        @clear="clearNarrowing"
      />

      <div v-if="page?.nextCursor" class="flex justify-center">
        <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">
          {{ listQuery.isFetching.value ? t('common.loading') : t('common.loadMore') }}
        </Button>
      </div>
    </div>

    <div v-else :id="panelId('settings')" role="tabpanel" :aria-labelledby="tabId('settings')">
      <HealthSettings :can-manage="auth.canAdminWorkspace" />
    </div>

    <HealthPreviewSheet :row="previewRow" @close="previewRow = null" />
  </PageLayout>
</template>
