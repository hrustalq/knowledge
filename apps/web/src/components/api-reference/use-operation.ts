import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { SearchApiOperationsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import type { PickedOperation } from './ApiOperationPicker.vue'

/**
 * One operation by entity key (#78), resolved to the spec that defines it at
 * that spec's head — the live API block, a workflow item and a graph node all
 * name an operation by key and need the page it lives on. `missing` is true
 * once the read settled and no spec the reader may open defines the key: an
 * operation removed from its spec, or one behind a restriction. That is decay
 * worth showing, never a reason to hide the link.
 */
export function useOperation(workspaceId: MaybeRefOrGetter<string>, entityKey: MaybeRefOrGetter<string | null | undefined>) {
  const query = useQuery(
    computed(() => ({
      ...apiQueryOptions('/v1/api-operations', {
        query: { workspaceId: toValue(workspaceId), entityKey: toValue(entityKey) ?? '', limit: 5 },
      }),
      enabled: Boolean(toValue(entityKey) && toValue(workspaceId)),
      staleTime: 60_000,
    })),
  )
  const operation = computed<PickedOperation | null>(
    () => (query.data.value as SearchApiOperationsResponse | undefined)?.operations[0] ?? null,
  )
  const missing = computed(() => query.isSuccess.value && !operation.value)
  return { operation, missing, isPending: query.isPending, isError: query.isError }
}

/** The spec page, scrolled to the operation (`?op=` is an opening instruction). */
export function operationHref(op: { documentId: string; entityKey: string }): string {
  return `/documents/${op.documentId}?op=${encodeURIComponent(op.entityKey)}`
}
