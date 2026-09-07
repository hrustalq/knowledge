<script setup lang="ts">
// Merge-request card stack. Used by the workspace page (pass rows) and the
// document tab (pass documentId — fetches the document-scoped list itself).
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { GitPullRequestArrow } from 'lucide-vue-next'
import type { ListMergeRequestsResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { Skeleton } from '@/components/ui/skeleton'
import MergeRequestCard from './MergeRequestCard.vue'

const props = defineProps<{ documentId?: string; rows?: MergeRequestInfo[]; loading?: boolean }>()

const documentQuery = useQuery({
  ...apiQueryOptions('/v1/documents/{id}/merge-requests', { path: { id: props.documentId ?? '' } }),
  enabled: computed(() => !!props.documentId),
})

const mergeRequests = computed<MergeRequestInfo[]>(() => {
  if (props.rows) return props.rows
  return (documentQuery.data.value as ListMergeRequestsResponse | undefined)?.mergeRequests ?? []
})
const isLoading = computed(() => props.loading ?? (!!props.documentId && documentQuery.isPending.value))
</script>

<template>
  <div v-if="isLoading" class="space-y-2">
    <Skeleton v-for="i in 3" :key="i" class="h-16 w-full" />
  </div>

  <div
    v-else-if="mergeRequests.length === 0"
    class="grid place-items-center rounded-lg border border-dashed bg-card py-16 text-center"
  >
    <GitPullRequestArrow class="size-8 text-muted-foreground/50" />
    <p class="mt-3 font-medium">No merge requests</p>
    <p class="mt-1 text-sm text-muted-foreground">
      Branch a document and open a merge request to propose changes.
    </p>
  </div>

  <div v-else class="space-y-2">
    <MergeRequestCard v-for="mr in mergeRequests" :key="mr.mergeRequestId" :merge-request="mr" />
  </div>
</template>
