<script setup lang="ts">
// Filter rail for the search sheet. Rendered twice — as the desktop left rail
// and inside the mobile disclosure — so it owns no layout of its own.
//
// Every facet is an autocomplete: workspace/project/category are bounded lists
// filtered in the browser, tags are unbounded and searched server-side via
// GET /v1/entities?type=tag&q=.
import { computed, ref } from 'vue'
import type { DocumentCategory, ListEntitiesResponse } from '@knowledge/contracts'
import { DOCUMENT_CATEGORIES } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import type { UseSearch } from './use-search'

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
        label="Workspace"
        placeholder="Switch workspace…"
        :multiple="false"
        :options="workspaceOptions"
        @update:model-value="onWorkspace"
      />
      <p class="text-[11px] leading-snug text-muted-foreground">Switching reloads the app.</p>
    </div>

    <div class="border-t" />

    <Autocomplete
      v-model="selectedProjects"
      label="Projects"
      placeholder="Filter by project…"
      :options="projectOptions"
      empty-hint="No projects in this workspace yet."
    />

    <Autocomplete
      v-model="selectedCategories"
      label="Category"
      placeholder="Filter by category…"
      :options="categoryOptions"
    />

    <Autocomplete
      v-model="selectedTags"
      label="Tags"
      placeholder="Filter by tag…"
      :load="loadTags"
      :fallback-label="(v: string) => v.replace(/^tag:/, '')"
      empty-hint="Tags come from a page's frontmatter `tags:` list."
    />

    <div class="border-t" />

    <section class="space-y-2.5 text-sm">
      <label class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Mode
        </span>
        <select
          v-model="search.mode.value"
          class="rounded-md border bg-background px-2 py-1 text-xs"
        >
          <option value="hybrid">hybrid</option>
          <option value="semantic">semantic</option>
          <option value="keyword">keyword</option>
        </select>
      </label>

      <label
        class="flex items-center justify-between gap-2"
        :class="search.mode.value !== 'hybrid' ? 'opacity-50' : ''"
      >
        <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            v-model="search.expand.value"
            type="checkbox"
            :disabled="search.mode.value !== 'hybrid'"
            class="accent-primary"
          />
          Graph expansion
        </span>
        <select
          v-model.number="search.depth.value"
          class="rounded-md border bg-background px-1.5 py-1 text-xs"
          :disabled="!search.expand.value || search.mode.value !== 'hybrid'"
          aria-label="Expansion depth"
        >
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>
      </label>

      <label class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Limit
        </span>
        <select
          v-model.number="search.limit.value"
          class="rounded-md border bg-background px-1.5 py-1 text-xs"
        >
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="50">50</option>
        </select>
      </label>
    </section>

    <button
      v-if="search.activeFilterCount.value > 0"
      type="button"
      class="text-xs text-primary hover:underline"
      @click="search.clearFilters()"
    >
      Clear {{ search.activeFilterCount.value }} filter{{
        search.activeFilterCount.value === 1 ? '' : 's'
      }}
    </button>
  </div>
</template>
