<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { DocumentDetailResponse } from '@knowledge/contracts'
import { apiFetch, statusVariant } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const route = useRoute()
const detail = ref<DocumentDetailResponse | null>(null)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    detail.value = await apiFetch<DocumentDetailResponse>(`/v1/documents/${route.params.id as string}`)
    const status = detail.value.revision.status
    // Poll while the ingestion pipeline is running.
    if (status === 'indexed' || status === 'failed' || status === 'draft') {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  } catch (e) {
    error.value = (e as Error).message
    if (timer) clearInterval(timer)
  }
}

onMounted(() => {
  void load()
  timer = setInterval(() => void load(), 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <p v-if="error" class="text-destructive">{{ error }}</p>

  <div v-else-if="!detail" class="space-y-2">
    <Skeleton class="h-8 w-1/2" />
    <Skeleton class="h-40 w-full" />
  </div>

  <div v-else class="space-y-4">
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-semibold">{{ detail.document.title }}</h1>
      <Badge :variant="statusVariant(detail.revision.status)">{{ detail.revision.status }}</Badge>
    </div>

    <Card>
      <CardHeader><CardTitle>Revision</CardTitle></CardHeader>
      <CardContent class="grid grid-cols-2 gap-2 text-sm">
        <span class="text-muted-foreground">Revision</span>
        <span>#{{ detail.revision.revisionNumber }} ({{ detail.revision.revisionId.slice(0, 8) }})</span>
        <span class="text-muted-foreground">Content type</span>
        <span>{{ detail.revision.contentType }}</span>
        <span class="text-muted-foreground">Content hash</span>
        <span class="truncate">{{ detail.revision.contentHash ?? '—' }}</span>
        <span class="text-muted-foreground">Finalized</span>
        <span>{{ detail.revision.finalizedAt ? new Date(detail.revision.finalizedAt).toLocaleString() : '—' }}</span>
      </CardContent>
    </Card>

    <Card v-if="detail.chunks.length > 0">
      <CardHeader><CardTitle>Chunks ({{ detail.chunks.length }})</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <div v-for="chunk in detail.chunks" :key="chunk.chunkId" class="rounded-md border p-3">
          <p v-if="chunk.headingPath.length" class="mb-1 text-xs font-medium text-muted-foreground">
            {{ chunk.headingPath.join(' › ') }}
          </p>
          <p class="text-sm">{{ chunk.snippet }}…</p>
        </div>
      </CardContent>
    </Card>

    <p v-else-if="detail.revision.status !== 'indexed'" class="text-sm text-muted-foreground">
      Chunks appear here once ingestion completes.
    </p>
  </div>
</template>
