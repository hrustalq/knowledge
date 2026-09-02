<script setup lang="ts">
// Feature 10 (docs/features/10): workspace / per-document activity stream.
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { ActivityEntry, ListActivityResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useEventsStore } from '@/stores/events'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{ documentId?: string }>()

const entries = ref<ActivityEntry[] | null>(null)
const nextCursor = ref<string | null>(null)
const busy = ref(false)
const events = useEventsStore()

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
}

function label(e: ActivityEntry): string {
  return ACTION_LABELS[e.action] ?? e.action
}

function relativeTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleString()
}

async function load(append = false) {
  busy.value = true
  try {
    const params = new URLSearchParams({ workspaceId: getWorkspaceId(), limit: '30' })
    if (props.documentId) params.set('documentId', props.documentId)
    if (append && nextCursor.value) params.set('cursor', nextCursor.value)
    const res = await apiFetch<ListActivityResponse>(`/v1/activity?${params}`)
    entries.value = append ? [...(entries.value ?? []), ...res.entries] : res.entries
    nextCursor.value = res.nextCursor
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
// Live refresh (feature 04): any workspace event re-pulls the first page.
watch(() => events.revision, () => void load())
</script>

<template>
  <div v-if="!entries" class="space-y-2">
    <Skeleton v-for="i in 3" :key="i" class="h-8 w-full" />
  </div>
  <p v-else-if="entries.length === 0" class="text-sm text-muted-foreground">No activity yet.</p>
  <div v-else class="space-y-1">
    <div
      v-for="e in entries"
      :key="e.id"
      class="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
    >
      <span class="font-medium">{{ e.actor === 'dev' || e.actor === '00000000-0000-0000-0000-000000000000' ? 'dev' : e.actor.slice(0, 8) }}</span>
      <span class="text-muted-foreground">{{ label(e) }}</span>
      <RouterLink
        v-if="e.documentId"
        :to="`/documents/${e.documentId}`"
        class="truncate font-medium hover:underline"
      >
        {{ e.documentTitle ?? (e.metadata.title as string) ?? e.documentId.slice(0, 8) }}
      </RouterLink>
      <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ relativeTime(e.createdAt) }}</span>
    </div>
    <Button v-if="nextCursor" variant="outline" size="sm" :disabled="busy" @click="load(true)">
      {{ busy ? 'Loading…' : 'Load more' }}
    </Button>
  </div>
</template>
