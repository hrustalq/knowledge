<script setup lang="ts">
// Workspace-wide merge-request list (/merge-requests), GitLab-style: status
// tabs with count badges, a filtered search bar, cards below.
//
// Every narrowing goes to the server. The list is cursor-paginated, so
// filtering the loaded page in the browser would disagree with both the tab
// counts and "Load more" — see mr-filters.ts.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { ListWorkspaceMergeRequestsResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { ActiveFilter } from '@/components/ui/filter-bar'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'
import MergeRequestSearchBar from '@/components/merge-requests/MergeRequestSearchBar.vue'
import { mergeRequestFilterParams } from '@/components/merge-requests/mr-filters'

const { t } = useI18n()

const STATES = ['open', 'merged', 'closed', 'all'] as const
type State = (typeof STATES)[number]

const state = ref<State>('open')
const filters = ref<ActiveFilter[]>([])
const search = ref('')
const cursor = ref<string | undefined>(undefined)
/** Accumulated previous pages (reset when filters change). */
const older = ref<MergeRequestInfo[]>([])

const queryParams = computed(() => ({
  workspaceId: getWorkspaceId(),
  ...(state.value !== 'all' ? { status: state.value } : {}),
  ...mergeRequestFilterParams(filters.value),
  ...(search.value ? { search: search.value } : {}),
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

// Narrowing the list invalidates the pages already stacked up behind it.
watch([filters, search], () => resetPaging())

const listQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests', { query: queryParams.value })),
)
const page = computed(() => listQuery.data.value as ListWorkspaceMergeRequestsResponse | undefined)
const rows = computed(() => [...older.value, ...(page.value?.mergeRequests ?? [])])

/** Tab badges keep the last known counts while a refetch is in flight. */
const lastCounts = ref<{ open: number; merged: number; closed: number } | null>(null)
watch(page, (p) => {
  if (p?.counts) lastCounts.value = p.counts
})
const counts = computed(() => lastCounts.value ?? { open: 0, merged: 0, closed: 0 })
const countFor = (s: State) =>
  s === 'all' ? counts.value.open + counts.value.merged + counts.value.closed : counts.value[s]

/** Drives the empty state's copy: "none yet" and "none match" are not the same. */
const narrowed = computed(() => search.value !== '' || filters.value.some((f) => f.values[0]))

function setState(next: State) {
  state.value = next
  resetPaging()
}
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
  filters.value = []
  search.value = ''
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('nav.mergeRequests') }}</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">
        {{ t('mr.listSubtitle') }}
      </p>
    </div>

    <!-- status tabs with count badges -->
    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="s in STATES"
        :key="s"
        role="tab"
        :aria-selected="state === s"
        class="flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors"
        :class="state === s
          ? 'border-primary font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="setState(s)"
      >
        {{ t(`mr.state${s.charAt(0).toUpperCase()}${s.slice(1)}`) }}
        <span class="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
          {{ countFor(s) }}
        </span>
      </button>
    </div>

    <MergeRequestSearchBar v-model:filters="filters" v-model:search="search" />

    <MergeRequestList
      :rows="rows"
      :loading="listQuery.isPending.value && rows.length === 0"
      :narrowed="narrowed"
      @clear="clearNarrowing"
    />

    <div v-if="page?.nextCursor" class="flex justify-center">
      <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">
        {{ listQuery.isFetching.value ? 'Loading…' : 'Load more' }}
      </Button>
    </div>
  </div>
</template>
