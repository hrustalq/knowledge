<script setup lang="ts">
// Filter rail for the search sheet. Rendered twice — as the desktop left rail
// and inside the mobile disclosure — so it owns no layout of its own.
//
// The three document facets (project, category, tag) live in DocumentFacets so
// the pages list offers exactly the same ones; what stays here is the part that
// is only meaningful while searching: which workspace, and how the query runs.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import type { DocumentCategory } from '@knowledge/contracts'
import { getWorkspaceId } from '@/lib/api'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import DocumentFacets from './DocumentFacets.vue'
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

const activeWs = ref([getWorkspaceId()])

const workspaceOptions = computed<AutocompleteOption[]>(() =>
  workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
)
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

    <DocumentFacets
      v-model:projects="selectedProjects"
      v-model:categories="selectedCategories"
      v-model:tags="selectedTags"
    />

    <div class="border-t" />

    <section class="space-y-2.5 text-sm">
      <div class="flex items-center justify-between gap-2">
        <Label
          for="search-mode"
          class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {{ t('search.mode') }}
        </Label>
        <Select v-model="search.mode.value">
          <SelectTrigger id="search-mode" size="sm" class="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">{{ t('search.modeHybrid') }}</SelectItem>
            <SelectItem value="semantic">{{ t('search.modeSemantic') }}</SelectItem>
            <SelectItem value="keyword">{{ t('search.modeKeyword') }}</SelectItem>
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
          {{ t('search.graphExpansion') }}
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
          {{ t('search.limit') }}
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
