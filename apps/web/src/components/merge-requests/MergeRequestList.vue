<script setup lang="ts">
// Merge-request card stack. Used by the workspace page (pass rows) and the
// document tab (pass documentId — fetches the document-scoped list itself).
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { GitPullRequestArrow, SearchX } from 'lucide-vue-next'
import type { ListMergeRequestsResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import MergeRequestCard from './MergeRequestCard.vue'

const { t } = useI18n()

const props = defineProps<{
  documentId?: string
  rows?: MergeRequestInfo[]
  loading?: boolean
  /**
   * A search or filter is active, so an empty result means "nothing matched",
   * not "nothing exists" — telling someone to open their first merge request
   * while they are filtering by author reads as a bug.
   */
  narrowed?: boolean
}>()
defineEmits<{ clear: [] }>()

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
    <template v-if="narrowed">
      <SearchX class="size-8 text-muted-foreground/50" />
      <p class="mt-3 font-medium">{{ t('mr.noMatches') }}</p>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ t('mr.noneMatchFilters') }}
      </p>
      <Button variant="outline" size="sm" class="mt-4" @click="$emit('clear')">
        {{ t('mr.clearSearchFilters') }}
      </Button>
    </template>
    <template v-else>
      <GitPullRequestArrow class="size-8 text-muted-foreground/50" />
      <p class="mt-3 font-medium">{{ t('mr.noMergeRequests') }}</p>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ t('mr.branchToPropose') }}
      </p>
    </template>
  </div>

  <div v-else class="space-y-2">
    <MergeRequestCard v-for="mr in mergeRequests" :key="mr.mergeRequestId" :merge-request="mr" />
  </div>
</template>
