<script setup lang="ts">
// Feature 02 (docs/features/02): the standalone /search page. Layout, filters
// and results all come from SearchPanel — the same component the global search
// sheet renders — so the two surfaces cannot diverge.
import { onMounted } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useWorkspacesStore } from '@/stores/workspaces'
import SearchPanel from './SearchPanel.vue'
import { useSearch } from './use-search'

const props = defineProps<{ initialQuery?: string }>()

const projects = useProjectsStore()
const workspaces = useWorkspacesStore()

const search = useSearch({ query: props.initialQuery ?? '' })

onMounted(() => {
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
  workspaces.ensureLoaded()
  if (search.query.value.trim()) void search.run()
})
</script>

<template>
  <SearchPanel
    :search="search"
    placeholder="What depends on the identity service?"
    @switch-workspace="workspaces.switchWorkspace($event)"
  />
</template>
