<script setup lang="ts">
// Feature 10 (docs/features/10): workspace / per-document activity stream.
// Cursor-paginated (auto-loads the next page on scroll) and virtualized, so a
// long-lived workspace feed stays at a few dozen DOM rows.
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useInfiniteScroll, useVirtualList } from '@vueuse/core'
import type { ActivityEntry, ListActivityResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, relativeTime } from '@/lib/api'
import { useEventsStore } from '@/stores/events'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

const props = withDefaults(
  defineProps<{ documentId?: string; pageSize?: number; height?: string }>(),
  { pageSize: 50, height: '60vh' },
)

/** Row height must match the markup below — the virtualizer positions by it. */
const ROW_HEIGHT = 34

const entries = ref<ActivityEntry[]>([])
const loaded = ref(false)
const busy = ref(false)
const nextCursor = ref<string | null>(null)
const events = useEventsStore()

const { list, containerProps, wrapperProps } = useVirtualList(entries, {
  itemHeight: ROW_HEIGHT,
  overscan: 10,
})

const ACTION_LABELS: Record<string, string> = {
  'document.created': 'created document',
  'document.updated': 'updated document',
  'revision.finalized': 'published a revision of',
  'branch.created': 'created a branch on',
  'relations.curated': 'curated a relation on',
  'relations.deleted': 'removed a relation from',
  'merge-request.created': 'opened a merge request on',
  'merge-request.approved': 'approved a merge request on',
  'merge-request.merged': 'merged a merge request on',
  'merge-request.closed': 'closed a merge request on',
  'merge-request.updated': 'updated a merge request on',
  'merge-request.reopened': 'reopened a merge request on',
  'merge-request.review-requested': 'requested review on',
  'merge-request.comment.created': 'commented on a merge request on',
  'merge-request.comment.resolved': 'resolved a review thread on',
}

function label(e: ActivityEntry): string {
  return ACTION_LABELS[e.action] ?? e.action
}

async function fetchPage(cursor?: string): Promise<ListActivityResponse> {
  const params = new URLSearchParams({ workspaceId: getWorkspaceId(), limit: String(props.pageSize) })
  if (props.documentId) params.set('documentId', props.documentId)
  if (cursor) params.set('cursor', cursor)
  return apiFetch<ListActivityResponse>(`/v1/activity?${params}`)
}

/** First page — resets the list (initial mount / workspace or document change). */
async function reload() {
  busy.value = true
  try {
    const res = await fetchPage()
    entries.value = res.entries
    nextCursor.value = res.nextCursor
    loaded.value = true
  } finally {
    busy.value = false
  }
}

/** Next page — appended, driven by the scroll handler and the fallback button. */
async function loadMore() {
  if (busy.value || !nextCursor.value) return
  busy.value = true
  try {
    const res = await fetchPage(nextCursor.value)
    entries.value = [...entries.value, ...res.entries]
    nextCursor.value = res.nextCursor
  } finally {
    busy.value = false
  }
}

/**
 * Live refresh (feature 04): re-pull only the first page and splice in what we
 * haven't seen, so an incoming event doesn't discard the pages already loaded.
 */
async function refreshHead() {
  if (!loaded.value) return
  const res = await fetchPage()
  const known = new Set(entries.value.map((e) => e.id))
  const fresh = res.entries.filter((e) => !known.has(e.id))
  if (fresh.length > 0) entries.value = [...fresh, ...entries.value]
}

useInfiniteScroll(containerProps.ref, () => loadMore(), {
  distance: ROW_HEIGHT * 6,
  canLoadMore: () => nextCursor.value !== null && !busy.value,
})

onMounted(() => void reload())
watch(() => props.documentId, () => void reload())
watch(() => events.revision, () => void refreshHead())
</script>

<template>
  <div v-if="!loaded" class="space-y-2">
    <Skeleton v-for="i in 3" :key="i" class="h-8 w-full" />
  </div>
  <p v-else-if="entries.length === 0" class="text-sm text-muted-foreground">No activity yet.</p>
  <div v-else class="flex min-h-0 flex-col gap-2">
    <div v-bind="containerProps" :style="{ height: props.height }" class="rounded-md">
      <div v-bind="wrapperProps">
        <div
          v-for="{ data: e, index } in list"
          :key="e.id ?? index"
          class="flex items-baseline gap-2 rounded-md px-2 text-sm hover:bg-muted/50"
          :style="{ height: `${ROW_HEIGHT}px` }"
        >
          <span class="shrink-0 font-medium">
            {{ e.actor === 'dev' || e.actor === '00000000-0000-0000-0000-000000000000' ? 'dev' : e.actor.slice(0, 8) }}
          </span>
          <span class="shrink-0 text-muted-foreground">{{ label(e) }}</span>
          <RouterLink
            v-if="e.documentId"
            :to="`/documents/${e.documentId}`"
            class="truncate font-medium hover:underline"
          >
            {{ e.documentTitle ?? (e.metadata.title as string) ?? e.documentId.slice(0, 8) }}
          </RouterLink>
          <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ relativeTime(e.createdAt) }}</span>
        </div>
      </div>
    </div>

    <!-- Scrolling pages in automatically; the button is the keyboard/fallback path. -->
    <div class="flex items-center gap-3 px-2 text-xs text-muted-foreground">
      <span>{{ entries.length }} loaded{{ nextCursor ? '' : ' — end of feed' }}</span>
      <Button v-if="nextCursor" variant="outline" size="sm" :disabled="busy" @click="loadMore">
        {{ busy ? 'Loading…' : 'Load more' }}
      </Button>
    </div>
  </div>
</template>
