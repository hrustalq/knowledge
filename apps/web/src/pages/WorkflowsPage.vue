<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Play, Workflow } from 'lucide-vue-next'
import type { ListWorkflowRunsResponse } from '@knowledge/contracts'
import { WORKFLOW_RUN_STATUSES } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { apiFetch, getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useWorkflowsStore } from '@/stores/workflows'
import {
  FilterBar,
  filterRows,
  type ActiveFilter,
  type FilterAccessors,
  type FilterField,
} from '@/components/ui/filter-bar'
import { Autocomplete } from '@/components/ui/autocomplete'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import WorkflowRunCard from '@/components/workflows/WorkflowRunCard.vue'

const { t } = useI18n()

/**
 * Every run in the workspace (docs/features/17).
 *
 * The project field is a *scope*, not a predicate — it decides what is fetched,
 * exactly as it does on the glossary page — while status, workflow and author
 * filter the fetched rows in memory. The status counts come from the server
 * under the same scope, so the badges do not move as you switch between them.
 */
const auth = useAuthStore()
const projects = useProjectsStore()
const store = useWorkflowsStore()

onMounted(() => {
  if (!projects.loaded) void projects.fetchList()
  void store.ensureLoaded()
})

const filters = ref<ActiveFilter[]>([])

const scopedProjectId = computed(
  () => filters.value.find((f) => f.key === 'project')?.values[0] ?? getProjectId() ?? undefined,
)

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/workflows/runs', {
      query: {
        workspaceId: getWorkspaceId(),
        ...(scopedProjectId.value ? { projectId: scopedProjectId.value } : {}),
        limit: 50,
      },
    }),
  ),
)
const data = computed(() => query.data.value as ListWorkflowRunsResponse | undefined)
const runs = computed(() => data.value?.runs ?? [])

const fields = computed<FilterField[]>(() => [
  {
    key: 'project',
    label: t('filter.project'),
    // Pinned: it scopes the fetch, so it is never offered as an addable filter
    // and Clear does not remove it.
    pinned: true,
    type: 'select',
    options: projects.items.map((p) => ({ value: p.projectId, label: p.name })),
  },
  {
    key: 'status',
    label: t('filter.status'),
    type: 'select',
    multiple: true,
    options: WORKFLOW_RUN_STATUSES.map((s) => ({
      value: s,
      label: s,
      meta: String(data.value?.counts?.[s] ?? 0),
    })),
  },
  {
    key: 'workflow',
    label: t('filter.workflow'),
    type: 'select',
    multiple: true,
    options: store.workflows.map((w) => ({ value: w.id, label: w.name })),
  },
  { key: 'page', label: t('filter.sourcePage'), type: 'text' },
])

const accessors: FilterAccessors<(typeof runs.value)[number]> = {
  project: (run) => run.projectId,
  status: (run) => run.status,
  workflow: (run) => run.definitionId,
  page: (run) => run.rootDocumentTitle ?? '',
}

const visible = computed(() =>
  filterRows(
    runs.value,
    // The project filter already shaped the fetch; re-applying it in memory
    // would drop nothing but costs a pass.
    filters.value.filter((f) => f.key !== 'project'),
    accessors,
  ),
)

// ------------------------------------------------------------------- start

const starting = ref(false)
const definitionId = ref<string | null>(null)
const documentIds = ref<string[]>([])
const note = ref('')

const startRun = useApiMutation('post', '/v1/workflows/runs', {
  invalidates: () => [['/v1/workflows/runs']],
})

/**
 * `apiFetch` rather than the typed client: `/v1/documents` declares Swagger
 * defaults for `cursor` and `category`, which `openapi-typescript` promotes to
 * required, so the typed call would have to invent values the server already
 * fills in.
 */
async function loadDocuments(q: string) {
  const params = new URLSearchParams({ workspaceId: getWorkspaceId(), limit: '20' })
  if (scopedProjectId.value) params.set('projectId', scopedProjectId.value)
  if (q) params.set('search', q)
  const res = await apiFetch<{ documents?: Array<{ id: string; title: string; category?: string }> }>(
    `/v1/documents?${params}`,
  )
  return (res.documents ?? []).map((d) => ({ value: d.id, label: d.title, meta: d.category }))
}

async function start() {
  if (!definitionId.value || !documentIds.value[0]) return
  try {
    await startRun.mutateAsync({
      body: {
        workspaceId: getWorkspaceId(),
        definitionId: definitionId.value,
        rootDocumentId: documentIds.value[0],
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      },
    })
    await query.refetch()
    starting.value = false
    documentIds.value = []
    note.value = ''
    toast.success(t('workflow.runStarted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

watch(starting, (open) => {
  if (open && !definitionId.value) definitionId.value = store.runnable[0]?.id ?? null
})
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col gap-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">{{ t('workflow.runs') }}</h1>
        <p class="text-muted-foreground mt-1 max-w-2xl text-sm">
          {{ t('workflow.runsSubtitle') }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <RouterLink to="/settings/workflows">
          <Button variant="outline" size="sm">{{ t('workflow.configure') }}</Button>
        </RouterLink>
        <Button v-if="auth.canEdit && store.runnable.length" size="sm" @click="starting = true">
          <Play class="mr-1.5 size-4" /> {{ t('workflow.startRunButton') }}
        </Button>
      </div>
    </header>

    <FilterBar v-model="filters" :fields="fields" :empty-label="t('workflow.filterRuns')" />

    <div v-if="query.isLoading.value" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-20 w-full" />
    </div>

    <div
      v-else-if="visible.length === 0"
      class="text-muted-foreground flex flex-col items-center gap-3 rounded-lg border border-dashed py-14 text-center"
    >
      <Workflow class="size-8 opacity-40" />
      <div>
        <p class="text-foreground text-sm font-medium">
          {{ runs.length ? t('workflow.list.noRunsMatch') : t('workflow.list.noRunsYet') }}
        </p>
        <p class="mx-auto mt-1 max-w-md text-sm">
          <template v-if="runs.length">{{ t('workflow.clearFilterToSeeRest') }}</template>
          <template v-else-if="store.runnable.length">
            {{ t('workflow.list.startFromHere') }}
          </template>
          <template v-else>
            {{ t('workflow.list.noneConfigured') }}
          </template>
        </p>
      </div>
      <RouterLink v-if="!store.runnable.length" to="/settings/workflows">
        <Button size="sm" variant="outline">{{ t('workflow.openSettings') }}</Button>
      </RouterLink>
    </div>

    <ul v-else class="space-y-2">
      <li v-for="run in visible" :key="run.id">
        <WorkflowRunCard :run="run" />
      </li>
    </ul>

    <Dialog v-model:open="starting">
      <DialogContent class="max-w-lg">
        <DialogHeader><DialogTitle>{{ t('workflow.startRun') }}</DialogTitle></DialogHeader>
        <div class="space-y-4">
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.workflow') }}</span>
            <select
              v-model="definitionId"
              class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <option v-for="w in store.runnable" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
          </label>

          <Autocomplete
            v-model="documentIds"
            :label="t('workflow.sourcePage')"
            :placeholder="t('workflow.list.searchPages')"
            :multiple="false"
            :load="loadDocuments"
            :empty-hint="t('hints.chainStartPage')"
          />

          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.list.notes') }}</span>
            <Textarea v-model="note" rows="2" :placeholder="t('workflow.list.notesPlaceholder')" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="starting = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="!definitionId || !documentIds[0] || startRun.isPending.value" @click="start">
            {{ startRun.isPending.value ? t('workflow.list.starting') : t('workflow.list.start') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
