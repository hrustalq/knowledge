<script setup lang="ts">
// Feature 02 (docs/features/02): the standalone /search page. Layout, filters
// and results all come from SearchPanel — the same component the global search
// sheet renders — so the two surfaces cannot diverge.
import { useI18n } from 'vue-i18n'
import { onMounted } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useWorkspacesStore } from '@/stores/workspaces'
import { appSearchSource } from '../model/app-search-source'
import SearchFilters from './SearchFilters.vue'
import SearchPanel from './SearchPanel.vue'
import { useSearch } from '../model/use-search'

const { t } = useI18n()

const props = defineProps<{ initialQuery?: string }>()

const projects = useProjectsStore()
const workspaces = useWorkspacesStore()

const search = useSearch(appSearchSource, { query: props.initialQuery ?? '' })

onMounted(() => {
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
  workspaces.ensureLoaded()
  if (search.query.value.trim()) void search.run()
})
</script>

<template>
  <SearchPanel :search="search" :placeholder="t('search.examplePlaceholder')">
    <template #filters>
      <SearchFilters :search="search" @switch-workspace="workspaces.switchWorkspace($event)" />
    </template>
  </SearchPanel>
</template>
