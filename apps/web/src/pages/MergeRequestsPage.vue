<script setup lang="ts">
// Workspace-wide merge-request list (/merge-requests), GitLab-style: status
// tabs with count badges + a search bar, cards below.
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { Search } from 'lucide-vue-next'
import type { ListWorkspaceMergeRequestsResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'

const STATES = ['open', 'merged', 'closed', 'all'] as const
type State = (typeof STATES)[number]

const auth = useAuthStore()
const state = ref<State>('open')
/** "Review requested" — MRs where the current user is an assigned reviewer. */
const mine = ref(false)
const searchInput = ref('')
const search = ref('')
const cursor = ref<string | undefined>(undefined)
/** Accumulated previous pages (reset when filters change). */
const older = ref<MergeRequestInfo[]>([])

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (next) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search.value = next.trim()
    resetPaging()
  }, 300)
})

const queryParams = computed(() => ({
  workspaceId: getWorkspaceId(),
  ...(state.value !== 'all' ? { status: state.value } : {}),
  ...(mine.value && auth.me ? { reviewerId: auth.me.userId } : {}),
  ...(search.value ? { search: search.value } : {}),
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

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
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">Merge requests</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">
        Review and merge proposed changes across this workspace.
      </p>
    </div>

    <!-- status tabs with count badges -->
    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="s in STATES"
        :key="s"
        role="tab"
        :aria-selected="state === s"
        class="flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm capitalize transition-colors"
        :class="state === s
          ? 'border-primary font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="setState(s)"
      >
        {{ s }}
        <span class="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
          {{ countFor(s) }}
        </span>
      </button>
    </div>

    <!-- search + quick filters -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-52 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="searchInput" placeholder="Search merge requests by title…" class="pl-8" />
      </div>
      <button
        v-if="auth.me"
        class="rounded-full border px-3 py-1 text-xs transition-colors"
        :class="mine
          ? 'border-primary bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
        @click="mine = !mine; resetPaging()"
      >
        review requested
      </button>
    </div>

    <MergeRequestList :rows="rows" :loading="listQuery.isPending.value && rows.length === 0" />

    <div v-if="page?.nextCursor" class="flex justify-center">
      <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">
        {{ listQuery.isFetching.value ? 'Loading…' : 'Load more' }}
      </Button>
    </div>
  </div>
</template>
