<script setup lang="ts">
// Global search surface: filters on the left rail, query top-right, results
// below it. Opened from the topbar trigger, "/" or Cmd/Ctrl+K. The sheet is
// SearchSheetFrame, shared with a published site's reader; what is the app's
// own lives here — the stores, the workspace switch, "open as page".
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ExternalLink } from 'lucide-vue-next'
import { useProjectsStore } from '@/stores/projects'
import { useSearchUiStore } from '@/modules/documents/model/search-ui.store'
import { useWorkspacesStore } from '@/stores/workspaces'
import { appSearchSource } from '@/entities/search'
import { SearchFilters } from '@/entities/search'
import { SearchSheetFrame } from '@/entities/search'
import { useSearch } from '@/entities/search'

const { t } = useI18n()

const ui = useSearchUiStore()
const workspaces = useWorkspacesStore()
const projects = useProjectsStore()
const router = useRouter()
const route = useRoute()

const search = useSearch(appSearchSource)
/** Set when a workspace switch dropped project/tag filters, so we can say so. */
const clearedNotice = ref(false)

const open = computed({
  get: () => ui.open,
  set: (v: boolean) => (v ? ui.openSearch() : ui.close()),
})

// Rosters are only needed once the sheet is actually used. Immediate, because
// the shell mounts the sheet on its first open (#279).
watch(
  () => ui.open,
  (isOpen) => {
    if (!isOpen) return
    workspaces.ensureLoaded()
    if (!projects.loaded) void projects.fetchList().catch(() => undefined)

    const seed = ui.seed
    if (seed) {
      const s = seed.snapshot
      if (s.query !== undefined) search.query.value = s.query
      if (s.mode) search.mode.value = s.mode
      if (s.categories) search.categories.value = new Set(s.categories)
      if (s.projectIds) search.projectIds.value = new Set(s.projectIds)
      if (s.tags) search.tags.value = new Set(s.tags)
      if (s.expand !== undefined) search.expand.value = s.expand
      if (s.depth) search.depth.value = s.depth
      if (s.limit) search.limit.value = s.limit
      if (s.asOf !== undefined) search.asOf.value = s.asOf
      clearedNotice.value = seed.clearedFilters
      ui.seed = null
      if (search.query.value.trim()) void search.run()
    }
  },
  { immediate: true },
)

function switchWorkspace(workspaceId: string) {
  ui.stashForWorkspaceSwitch(workspaceId, search.snapshot())
  workspaces.switchWorkspace(workspaceId)
}

function openFullPage() {
  const q = search.query.value.trim()
  ui.close()
  void router.push(q ? { path: '/search', query: { q } } : '/search')
}

// Clicking a result navigates; close so the page underneath is visible.
watch(() => route.fullPath, () => ui.close())
</script>

<template>
  <SearchSheetFrame
    v-model:open="open"
    :search="search"
    trigger-id="global-search-trigger"
    :title="t('nav.search')"
    :description="t('search.sheetDescription')"
    @navigate="ui.close()"
  >
    <template #filters>
      <SearchFilters :search="search" @switch-workspace="switchWorkspace" />
    </template>

    <template #actions>
      <button
        v-if="search.hasSearched.value"
        type="button"
        class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        @click="openFullPage"
      >
        {{ t('search.openAsPage') }}
        <ExternalLink class="size-3" />
      </button>
    </template>

    <template #footer>
      <p v-if="clearedNotice" class="px-4 pb-3 text-xs text-muted-foreground">
        {{ t('search.filtersClearedForWorkspace') }}
      </p>
    </template>
  </SearchSheetFrame>
</template>
