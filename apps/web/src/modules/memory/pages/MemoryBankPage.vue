<script setup lang="ts">
/**
 * /settings/memory/:id (#994): one memory bank — its facts and observations,
 * newest first. Viewers read; editors delete a memory, promote one to a page
 * (a capture, so a merge request) and bind the bank to a project, which the
 * API allows only to someone who can manage that project.
 *
 * Two more tabs (#1010) show what the other wires wrote into the same bank:
 * the graph's entities and relations, and the memory tool's files. Both are
 * read-only but for delete. `?tab=entities|files` opens one; it is an opening
 * instruction, not two-way state.
 *
 * A memory is an agent's own note from sources nobody reviewed: shown as
 * plain text, never rendered as markdown.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { ArrowLeft, Brain, FileUp, Search, Trash2 } from 'lucide-vue-next'
import type { MemoryUnitListResponse, MemoryUnitSummary, MemoryUnitType } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { formatDateTime } from '@/shared/utils/format'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { PageHeader, PageState, PageTabs, panelId, tabId, type PageTab } from '@knowledge/ui/layout'
import BankEntitiesPanel from '../components/BankEntitiesPanel.vue'
import BankFilesPanel from '../components/BankFilesPanel.vue'
import PromoteMemoryDialog from '../components/PromoteMemoryDialog.vue'

const PAGE = 50
/** What the API serves in one read; past it, searching narrows the list. */
const MAX = 200
const WORKSPACE = '__workspace'
type Filter = 'all' | MemoryUnitType
type Section = 'memories' | 'entities' | 'files'
const SECTION_SCOPE = 'bank'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const projects = useProjectsStore()
const queryClient = useQueryClient()
const id = computed(() => String(route.params.id))
const section = ref<Section>(route.query.tab === 'entities' || route.query.tab === 'files' ? route.query.tab : 'memories')

const filter = ref<Filter>('all')
const search = ref('')
const q = refDebounced(search, 300)
const limit = ref(PAGE)
watch([filter, q], () => (limit.value = PAGE))

const options = computed(() =>
  apiQueryOptions('/v1/memory/banks/{id}/memories', {
    path: { id: id.value },
    query: { ...(filter.value === 'all' ? {} : { type: filter.value }), ...(q.value.trim() ? { q: q.value.trim() } : {}), limit: limit.value },
  }),
)
const listQuery = useQuery(computed(() => ({ ...options.value, placeholderData: keepPreviousData })))
const data = computed(() => listQuery.data.value as MemoryUnitListResponse | undefined)
const bank = computed(() => data.value?.bank)
const refresh = () => queryClient.invalidateQueries({ queryKey: ['/v1/memory/banks/{id}/memories'] })

const tabs = computed<PageTab<Filter>[]>(() => [
  { key: 'all', label: t('memory.bank.all') },
  { key: 'world', label: t('memory.types.world') },
  { key: 'experience', label: t('memory.types.experience') },
  { key: 'observation', label: t('memory.banks.observations'), count: bank.value?.observations ?? null },
])

const sections = computed<PageTab<Section>[]>(() => [
  { key: 'memories', label: t('memory.bank.memories'), count: bank.value ? bank.value.facts + bank.value.observations : null },
  { key: 'entities', label: t('memory.bank.entities'), count: bank.value?.entities ?? null },
  { key: 'files', label: t('memory.bank.files'), count: bank.value?.files ?? null },
])

if (!projects.loaded) void projects.fetchList().catch(() => undefined)

/* ---------------------------------------------------------------- binding */

const binding = ref(false)
async function bind(value: string) {
  if (!bank.value || binding.value) return
  binding.value = true
  try {
    await api.patch('/v1/memory/banks/{id}', { path: { id: id.value }, body: { projectId: value === WORKSPACE ? null : value } })
    toast.success(t('memory.bank.bound'))
    await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['/v1/memory/banks'] })])
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    binding.value = false
  }
}
const boundTo = computed(() => bank.value?.projectId ?? WORKSPACE)
/** A project the caller cannot list is still the bank's: named, not dropped from the select. */
const boundElsewhere = computed(() => !!bank.value?.projectId && !projects.items.some((p) => p.projectId === bank.value?.projectId))

/* --------------------------------------------------------- delete, promote */

const busy = ref<string | null>(null)
async function remove(memory: MemoryUnitSummary) {
  busy.value = memory.id
  try {
    await api.delete('/v1/memory/banks/{id}/memories/{memoryId}', { path: { id: id.value, memoryId: memory.id } })
    toast.success(t('memory.bank.memoryDeleted'))
    await refresh()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}
const promoting = ref<MemoryUnitSummary | null>(null)
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-5">
    <RouterLink to="/settings/memory" class="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ t('memory.title') }}
    </RouterLink>

    <PageState v-if="listQuery.isPending.value" state="loading" :rows="4" row-class="h-14" />
    <PageState v-else-if="listQuery.isError.value && !data" state="error" :error="listQuery.error.value" />

    <template v-else-if="bank">
      <PageHeader>
        <template #title>
          <h1 class="font-display text-2xl font-bold tracking-tight break-all">{{ bank.bankId }}</h1>
        </template>
        <template #meta>
          <p class="text-sm text-muted-foreground">
            <span v-if="bank.name !== bank.bankId">{{ bank.name }} · </span>{{ t('memory.bank.factsN', { n: bank.facts }, bank.facts) }}, {{ t('memory.bank.observationsN', { n: bank.observations }, bank.observations) }}
          </p>
        </template>
      </PageHeader>

      <div class="flex flex-wrap items-end gap-3">
        <div class="w-full space-y-1.5 sm:w-64">
          <label for="bank-project" class="text-xs text-muted-foreground">{{ t('memory.bank.project') }}</label>
          <Select :model-value="boundTo" :disabled="!auth.canEdit || binding" @update:model-value="(v) => bind(String(v))">
            <SelectTrigger id="bank-project" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="WORKSPACE">{{ t('memory.wholeWorkspace') }}</SelectItem>
              <SelectItem v-if="boundElsewhere" :value="bank.projectId!">{{ t('memory.hiddenProject') }}</SelectItem>
              <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p class="kn-measure pb-2 text-xs text-muted-foreground sm:flex-1">{{ t('memory.bank.projectHint') }}</p>
      </div>

      <PageTabs v-model="section" :tabs="sections" :label="t('memory.bank.sections')" :scope="SECTION_SCOPE" />

      <div v-if="section === 'memories'" :id="panelId('memories', SECTION_SCOPE)" role="tabpanel" :aria-labelledby="tabId('memories', SECTION_SCOPE)" class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <PageTabs v-model="filter" :tabs="tabs" :label="t('memory.bank.filter')" class="min-w-0" />
          <label class="relative w-full sm:ml-auto sm:w-64">
            <span class="sr-only">{{ t('memory.bank.search') }}</span>
            <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input v-model="search" type="search" class="pl-8" :placeholder="t('memory.bank.search')" />
          </label>
        </div>

        <div :id="panelId(filter)" role="tabpanel" :aria-labelledby="tabId(filter)" class="min-w-0">
          <PageState
            v-if="!data?.items.length"
            state="empty"
            :icon="Brain"
            :title="q ? t('memory.bank.noMatchTitle') : t('memory.bank.emptyTitle')"
            :description="q ? t('memory.bank.noMatch') : t('memory.bank.empty')"
          />
          <ul v-else class="divide-y rounded-md border" :aria-busy="listQuery.isFetching.value">
            <li v-for="m in data.items" :key="m.id" class="flex gap-3 px-3 py-2.5">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-xs text-muted-foreground">
                  <span class="font-medium text-foreground/80">{{ t(`memory.types.${m.type}`) }}</span>
                  <template v-if="m.type === 'observation'"> · {{ t('memory.bank.proof', { n: m.proofCount }, m.proofCount) }}</template>
                  <template v-if="m.occurredAt"> · <time :datetime="m.occurredAt">{{ formatDateTime(m.occurredAt) }}</time></template>
                </p>
                <p class="kn-measure text-sm break-words whitespace-pre-wrap">{{ m.text }}</p>
                <p v-if="m.context" class="kn-measure text-xs break-words text-muted-foreground">{{ m.context }}</p>
                <p v-if="m.entities.length || m.tags.length" class="text-caption break-words text-muted-foreground">
                  <span v-if="m.entities.length">{{ m.entities.join(', ') }}</span>
                  <span v-if="m.entities.length && m.tags.length"> · </span>
                  <span v-if="m.tags.length" class="font-mono">{{ m.tags.join(' ') }}</span>
                </p>
              </div>
              <div v-if="auth.canEdit" class="-my-1 flex shrink-0 items-start gap-0.5">
                <Button size="icon" variant="ghost" class="size-8 text-muted-foreground" :aria-label="t('memory.promote.action')" :title="t('memory.promote.action')" @click="promoting = m">
                  <FileUp class="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  class="size-8 text-muted-foreground hover:text-destructive"
                  :disabled="busy === m.id"
                  :aria-label="t('memory.bank.deleteMemory')"
                  :title="t('memory.bank.deleteMemory')"
                  @click="remove(m)"
                >
                  <Trash2 class="size-4" />
                </Button>
              </div>
            </li>
          </ul>
          <div v-if="data && data.items.length < data.total" class="mt-3 flex items-center gap-3">
            <Button v-if="limit < MAX" variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="limit = Math.min(limit + PAGE, MAX)">{{ t('memory.bank.more') }}</Button>
            <span class="text-xs text-muted-foreground tabular-nums">{{ t(limit < MAX ? 'memory.bank.shown' : 'memory.bank.shownSearch', { shown: data.items.length, total: data.total }) }}</span>
          </div>
        </div>
      </div>
      <div v-else :id="panelId(section, SECTION_SCOPE)" role="tabpanel" :aria-labelledby="tabId(section, SECTION_SCOPE)" class="min-w-0">
        <BankEntitiesPanel v-if="section === 'entities'" :bank-id="bank.id" />
        <BankFilesPanel v-else :bank-id="bank.id" />
      </div>

      <PromoteMemoryDialog v-if="promoting" :open="!!promoting" :bank-id="bank.id" :memory="promoting" :project-id="bank.projectId" @update:open="(v) => { if (!v) promoting = null }" />
    </template>
  </div>
</template>
