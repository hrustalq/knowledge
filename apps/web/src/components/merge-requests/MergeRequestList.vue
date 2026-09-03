<script setup lang="ts">
// Merge-request table, reused by the workspace page (pass rows) and the
// document tab (pass documentId — it fetches the document-scoped list itself).
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { ListMergeRequestsResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { relativeTime, statusVariant } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

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
  <div>
    <Skeleton v-if="isLoading" class="h-24 w-full" />
    <p v-else-if="mergeRequests.length === 0" class="py-6 text-center text-sm text-muted-foreground">
      No merge requests.
    </p>
    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Branches</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Author</TableHead>
          <TableHead class="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="mr in mergeRequests" :key="mr.mergeRequestId">
          <TableCell>
            <RouterLink
              :to="`/merge-requests/${mr.mergeRequestId}`"
              class="font-medium text-primary hover:underline"
            >{{ mr.title }}</RouterLink>
            <Badge v-if="mr.isDraft" variant="outline" class="ml-2">Draft</Badge>
          </TableCell>
          <TableCell class="font-mono text-xs text-muted-foreground">
            {{ mr.sourceBranch }} → {{ mr.targetBranch }}
          </TableCell>
          <TableCell><Badge :variant="statusVariant(mr.status)">{{ mr.status }}</Badge></TableCell>
          <TableCell class="font-mono text-xs text-muted-foreground">{{ mr.authorId.slice(0, 8) }}</TableCell>
          <TableCell class="text-right text-xs text-muted-foreground">{{ relativeTime(mr.createdAt) }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
