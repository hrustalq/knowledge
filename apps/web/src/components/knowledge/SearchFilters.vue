<script setup lang="ts">
// Filter rail for the search sheet. Rendered twice — as the desktop left rail
// and inside the mobile disclosure — so it owns no layout of its own.
//
// Every facet is an autocomplete: workspace/project/category are bounded lists
// filtered in the browser, tags are unbounded and searched server-side via
// GET /v1/entities?type=tag&q=.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import type { DocumentCategory, ListEntitiesResponse } from '@knowledge/contracts'
import { DOCUMENT_CATEGORIES } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { UseSearch } from './use-search'

const { t } = useI18n()

const props = defineProps<{ search: UseSearch }>()
const emit = defineEmits<{ 'switch-workspace': [workspaceId: string] }>()

const workspaces = useWorkspacesStore()
const projects = useProjectsStore()

const activeWs = ref([getWorkspaceId()])

const workspaceOptions = computed<AutocompleteOption[]>(() =>
  workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
)
const projectOptions = computed<AutocompleteOption[]>(() =>
  projects.items.map((p) => ({
    value: p.projectId,
    label: p.name,
    meta: p.documentCount,
  })),
)
const categoryOptions = computed<AutocompleteOption[]>(() =>
  DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: c })),
)

/** Server-side tag search: the roster is unbounded, so it is not held locally. */
async function loadTags(query: string): Promise<AutocompleteOption[]> {
  // The list virtualizes, so a deep roster costs render nothing; server-side
  // `q` still narrows it before it ever reaches the browser.
  const params = new URLSearchParams({
    workspaceId: getWorkspaceId(),
    type: 'tag',
    limit: '200',
  })
  if (query.trim()) params.set('q', query.trim())
  const res = await apiFetch<ListEntitiesResponse>(`/v1/entities?${params}`)
  return res.entities.map((e) => ({ value: e.key, label: e.name, meta: e.degree }))
}

// The autocompletes speak string[]; the composable holds Sets.
const selectedCategories = computed({
  get: () => [...props.search.categories.value],
  set: (v: string[]) => {
    props.search.categories.value = new Set(v as DocumentCategory[])
  },
})
const selectedProjects = computed({
  get: () => [...props.search.projectIds.value],
  set: (v: string[]) => {
    props.search.projectIds.value = new Set(v)
  },
})
const selectedTags = computed({
  get: () => [...props.search.tags.value],
  set: (v: string[]) => {
    props.search.tags.value = new Set(v)
  },
})

function onWorkspace(next: string[]) {
  const id = next[0]
  if (!id || id === getWorkspaceId()) return
  activeWs.value = [id]
  emit('switch-workspace', id)
}
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-1">
      <Autocomplete
        :model-value="activeWs"
        :label="t('search.workspace')"
        :placeholder="t('search.switchWorkspace')"
        :multiple="false"
        :options="workspaceOptions"
        @update:model-value="onWorkspace"
      />
      <p class="text-[11px] leading-snug text-muted-foreground">{{ t('search.switchingReloads') }}</p>
    </div>

    <div class="border-t" />

    <Autocomplete
      v-model="selectedProjects"
      :label="t('search.projects')"
      :placeholder="t('search.filterByProject')"
      :options="projectOptions"
      :empty-hint="t('hints.noProjects')"
    />

    <Autocomplete
      v-model="selectedCategories"
      :label="t('search.category')"
      :placeholder="t('search.filterByCategory')"
      :options="categoryOptions"
    />

    <Autocomplete
      v-model="selectedTags"
      :label="t('search.tags')"
      :placeholder="t('search.filterByTag')"
      :load="loadTags"
      :fallback-label="(v: string) => v.replace(/^tag:/, '')"
      :empty-hint="t('hints.tagsFromFrontmatter')"
    />

    <div class="border-t" />

    <section class="space-y-2.5 text-sm">
      <div class="flex items-center justify-between gap-2">
        <Label
          for="search-mode"
          class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Mode
        </Label>
        <Select v-model="search.mode.value">
          <SelectTrigger id="search-mode" size="sm" class="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">hybrid</SelectItem>
            <SelectItem value="semantic">semantic</SelectItem>
            <SelectItem value="keyword">keyword</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div
        class="flex items-center justify-between gap-2"
        :class="search.mode.value !== 'hybrid' ? 'opacity-50' : ''"
      >
        <Label for="search-expand" class="gap-1.5 text-xs font-normal text-muted-foreground">
          <Checkbox
            id="search-expand"
            v-model="search.expand.value"
            :disabled="search.mode.value !== 'hybrid'"
          />
          Graph expansion
        </Label>
        <Select
          v-model="search.depth.value"
          :disabled="!search.expand.value || search.mode.value !== 'hybrid'"
        >
          <SelectTrigger size="sm" class="text-xs" :aria-label="t('search.expansionDepth')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="1">1</SelectItem>
            <SelectItem :value="2">2</SelectItem>
            <SelectItem :value="3">3</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center justify-between gap-2">
        <Label
          for="search-limit"
          class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Limit
        </Label>
        <Select v-model="search.limit.value">
          <SelectTrigger id="search-limit" size="sm" class="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="10">10</SelectItem>
            <SelectItem :value="20">20</SelectItem>
            <SelectItem :value="50">50</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>

    <button
      v-if="search.activeFilterCount.value > 0"
      type="button"
      class="text-xs text-primary hover:underline"
      @click="search.clearFilters()"
    >
      {{
        t('search.clearFilters', {
          filters: t('search.activeFilters', { n: search.activeFilterCount.value }, search.activeFilterCount.value),
        })
      }}
    </button>
  </div>
</template>
