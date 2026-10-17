import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { ApiOperationInfo, ApiSpecDocumentResponse, ListApiOperationsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { groupByTag, operationRowKey } from '@/lib/api-spec'

/** The element id an operation's card carries: stable, so `#op-…` links keep working. */
export function operationDomId(o: { entityKey: string; method: string | null }): string {
  return `op-${operationRowKey(o).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

/**
 * One spec's reference state (#78), shared by the Operations widget in the page
 * rail and the operations in the main column, which live in separate slots of
 * the document page.
 *
 * Every operation is on the page; the rail scrolls to one and the content
 * reports back which one is being read (`active`), the way "On this page" does
 * for a page's headings. `?op=<entityKey>` scrolls to that operation once on
 * arrival — an opening instruction, not two-way state.
 */
export function useApiReference(documentId: Ref<string>, revisionId: Ref<string | null>, enabled: Ref<boolean>) {
  const route = useRoute()
  const query = computed(() => (revisionId.value ? { revisionId: revisionId.value } : {}))

  const specQuery = useQuery(
    computed(() => ({
      ...apiQueryOptions('/v1/api-specs/{id}', { path: { id: documentId.value }, query: query.value }),
      enabled: enabled.value,
    })),
  )
  const opsQuery = useQuery(
    computed(() => ({
      ...apiQueryOptions('/v1/api-specs/{id}/operations', { path: { id: documentId.value }, query: query.value }),
      enabled: enabled.value,
      // Rows appear once the revision is indexed; until then, look again.
      refetchInterval: (q: { state: { data?: unknown } }) =>
        (q.state.data as ListApiOperationsResponse | undefined)?.revisionStatus === 'indexed' ? false : 3000,
    })),
  )

  const spec = computed(() => specQuery.data.value as ApiSpecDocumentResponse | undefined)
  const list = computed(() => opsQuery.data.value as ListApiOperationsResponse | undefined)
  const operations = computed<ApiOperationInfo[]>(() => list.value?.operations ?? [])
  const groups = computed(() => groupByTag(operations.value))

  /** The operation being read, as the content's scroll-spy last saw it. */
  const active = ref<string | null>(null)

  function scrollTo(op: ApiOperationInfo, behavior: ScrollBehavior = 'smooth') {
    if (import.meta.env.SSR) return
    active.value = operationRowKey(op)
    document.getElementById(operationDomId(op))?.scrollIntoView({ behavior, block: 'start' })
  }

  // The opening instruction, once the cards exist (and the spec they need).
  let arrived = false
  watch(
    [operations, spec],
    async ([rows, s]) => {
      if (arrived || rows.length === 0 || !s) return
      arrived = true
      const wanted = typeof route.query.op === 'string' ? route.query.op : null
      const hit = wanted ? rows.find((o) => o.entityKey === wanted || operationRowKey(o) === wanted) : null
      if (!hit) return
      await nextTick()
      scrollTo(hit, 'auto')
    },
    { immediate: true },
  )
  // Another document, or another revision of this one, starts over.
  watch([documentId, revisionId], () => {
    active.value = null
    arrived = false
  })

  return {
    spec,
    operations,
    groups,
    active,
    scrollTo,
    revisionStatus: computed(() => list.value?.revisionStatus ?? null),
    error: computed(() => (specQuery.error.value as Error | null) ?? null),
  }
}

export type ApiReferenceState = ReturnType<typeof useApiReference>
