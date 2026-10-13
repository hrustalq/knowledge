<script setup lang="ts">
// Global search surface: filters on the left rail, query top-right, results
// below it. Opened from the topbar trigger, "/" or Cmd/Ctrl+K.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { watchDebounced } from '@vueuse/core'
import { ExternalLink } from 'lucide-vue-next'
import { createFocusReturn } from '@/lib/search-shortcut'
import { useProjectsStore } from '@/stores/projects'
import { useSearchUiStore } from '@/stores/search-ui'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import SearchPanel from './SearchPanel.vue'
import { useSearch } from './use-search'

const { t } = useI18n()

const ui = useSearchUiStore()
const workspaces = useWorkspacesStore()
const projects = useProjectsStore()
const router = useRouter()
const route = useRoute()

const search = useSearch()
const panelEl = ref<InstanceType<typeof SearchPanel> | null>(null)
/** Set when a workspace switch dropped project/tag filters, so we can say so. */
const clearedNotice = ref(false)

const open = computed({
  get: () => ui.open,
  set: (v: boolean) => (v ? ui.openSearch() : ui.close()),
})

// Rosters are only needed once the sheet is actually used.
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
      clearedNotice.value = seed.clearedFilters
      ui.seed = null
      if (search.query.value.trim()) void search.run()
    }
  },
)

/** Focus the query field rather than the close button. */
function focusQuery() {
  void nextTick(() => panelEl.value?.focusQuery())
}

// Opened programmatically, so focus is handed back by hand (search-shortcut.ts).
const focusReturn = createFocusReturn('global-search-trigger')
watch(
  () => ui.open,
  (isOpen) => {
    if (isOpen) focusReturn.remember()
  },
)

// Toggling a facet re-runs the query — but only once there are results to
// refine, so flipping filters before the first search fires nothing.
watchDebounced(
  () => [
    search.mode.value,
    [...search.categories.value],
    [...search.projectIds.value],
    [...search.tags.value],
    search.expand.value,
    search.depth.value,
    search.limit.value,
  ],
  () => {
    if (search.hasSearched.value && search.query.value.trim()) void search.run()
  },
  { debounce: 250, deep: true },
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
  <Sheet v-model:open="open">
    <SheetContent
      side="right"
      class="w-full gap-0 p-0 sm:max-w-3xl lg:max-w-5xl"
      @open-auto-focus.prevent="focusQuery"
      @close-auto-focus="focusReturn.onCloseAutoFocus"
    >
      <SheetHeader class="sr-only">
        <SheetTitle>{{ t('nav.search') }}</SheetTitle>
        <SheetDescription>
          {{ t('search.sheetDescription') }}
        </SheetDescription>
      </SheetHeader>

      <SearchPanel
        ref="panelEl"
        class="min-h-0 flex-1"
        rail-surface
        :search="search"
        @navigate="ui.close()"
        @switch-workspace="switchWorkspace"
      >
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
      </SearchPanel>

      <p v-if="clearedNotice" class="px-4 pb-3 text-xs text-muted-foreground">
        {{ t('search.filtersClearedForWorkspace') }}
      </p>
    </SheetContent>
  </Sheet>
</template>
