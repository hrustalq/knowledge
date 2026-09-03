<script setup lang="ts">
// Workspace-wide merge-request list: /merge-requests (feature: full MR workflow).
// First consumer of the typed vue-query client (apiQueryOptions + infinite cursor).
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { ListWorkspaceMergeRequestsResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'

const status = ref<'all' | 'open' | 'merged' | 'closed'>('open')
const authorId = ref('')
const cursor = ref<string | undefined>(undefined)
/** Accumulated pages (reset when filters change). */
const older = ref<MergeRequestInfo[]>([])

const queryParams = computed(() => ({
  workspaceId: getWorkspaceId(),
  ...(status.value !== 'all' ? { status: status.value } : {}),
  ...(authorId.value.trim() ? { authorId: authorId.value.trim() } : {}),
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

const listQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests', { query: queryParams.value })),
)
const page = computed(() => listQuery.data.value as ListWorkspaceMergeRequestsResponse | undefined)
const rows = computed(() => [...older.value, ...(page.value?.mergeRequests ?? [])])

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
  <div class="mx-auto max-w-5xl space-y-4 p-6">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-xl font-semibold">Merge requests</h1>
      <div class="ml-auto flex items-center gap-2">
        <select
          v-model="status"
          class="h-8 rounded-md border bg-background px-2 text-sm"
          @change="resetPaging"
        >
          <option value="open">Open</option>
          <option value="merged">Merged</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <input
          v-model="authorId"
          placeholder="Author id…"
          class="h-8 w-44 rounded-md border bg-background px-2 font-mono text-xs"
          @change="resetPaging"
        />
      </div>
    </div>
    <MergeRequestList :rows="rows" :loading="listQuery.isPending.value && rows.length === 0" />
    <div v-if="page?.nextCursor" class="flex justify-center">
      <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">Load more</Button>
    </div>
  </div>
</template>
