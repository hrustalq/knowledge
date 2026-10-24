import { computed, ref, type Ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  ApiTestBindingsResponse,
  ApiTestFixtureCandidatesResponse,
  ListTestFixturesResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'

const POLL_MS = 2_500

/**
 * The fixtures behind one operation's QA suite (#483): what is bound, what
 * the spec suggests, the library to pick anything else from, and the tester's
 * ranking. Every change is one PUT of the whole list — the person's click is
 * the confirmation — and it moves the suite's cache key, so the suite query
 * is invalidated with it (it 404s until the next Generate).
 */
export function useSuiteFixtures(
  workspaceId: () => string,
  documentId: () => string,
  entityKey: () => string,
  active: Ref<boolean>,
  suiteKey: () => readonly unknown[],
) {
  const client = useQueryClient()
  const op = () => ({ path: { id: documentId() }, query: { entityKey: entityKey() } })

  const bindingsOptions = computed(() => apiQueryOptions('/v1/api-specs/{id}/test-bindings', op()))
  const bindingsQuery = useQuery(computed(() => ({ ...bindingsOptions.value, enabled: active.value })))
  const bindings = computed(() => bindingsQuery.data.value as ApiTestBindingsResponse | undefined)

  const candidatesOptions = computed(() => apiQueryOptions('/v1/api-specs/{id}/test-fixture-candidates', op()))
  const candidatesQuery = useQuery(
    computed(() => ({
      ...candidatesOptions.value,
      enabled: active.value,
      refetchInterval: (q: { state: { data: unknown } }) =>
        (q.state.data as ApiTestFixtureCandidatesResponse | undefined)?.ranking.status === 'pending' ? POLL_MS : false,
    })),
  )
  const candidates = computed(() => candidatesQuery.data.value as ApiTestFixtureCandidatesResponse | undefined)

  const libraryQuery = useQuery(
    computed(() => ({
      // The spec's workspace, not the one selected: only its fixtures can be bound.
      ...apiQueryOptions('/v1/test-fixtures', { query: { workspaceId: workspaceId() } }),
      enabled: active.value,
    })),
  )
  const library = computed(() => (libraryQuery.data.value as ListTestFixturesResponse | undefined)?.fixtures ?? [])

  /** Anything worth a Setup section: a binding, or a candidate the spec points at. */
  const hasAny = computed(
    () => !!bindings.value?.suite.length || Object.keys(bindings.value?.cases ?? {}).length > 0 || !!candidates.value?.prerequisites.length,
  )

  const save = useApiMutation('put', '/v1/api-specs/{id}/test-bindings', {
    invalidates: () => [suiteKey(), candidatesOptions.value.queryKey],
  })
  const error = ref<string | null>(null)

  async function write(next: Array<{ caseId: string | null; fixtureId: string }>) {
    error.value = null
    try {
      const res = await save.mutateAsync({
        path: { id: documentId() },
        body: { entityKey: entityKey(), bindings: next.map((b) => (b.caseId ? b : { fixtureId: b.fixtureId })) },
      })
      client.setQueryData(bindingsOptions.value.queryKey, res)
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  const current = () => {
    const b = bindings.value
    if (!b) return []
    return [
      ...b.suite.map((x) => ({ caseId: null as string | null, fixtureId: x.fixtureId })),
      ...Object.entries(b.cases).flatMap(([caseId, xs]) => xs.map((x) => ({ caseId: caseId as string | null, fixtureId: x.fixtureId }))),
    ]
  }
  const bind = (fixtureId: string, caseId: string | null = null) => write([...current(), { caseId, fixtureId }])
  const unbind = (fixtureId: string, caseId: string | null = null) =>
    write(current().filter((b) => !(b.fixtureId === fixtureId && b.caseId === caseId)))

  const rankMutation = useApiMutation('post', '/v1/api-specs/{id}/test-fixture-candidates/rank', {
    invalidates: () => [candidatesOptions.value.queryKey],
  })
  const rankError = ref<string | null>(null)
  async function rank() {
    rankError.value = null
    try {
      await rankMutation.mutateAsync({ path: { id: documentId() }, body: { entityKey: entityKey() } })
    } catch (e) {
      rankError.value = (e as Error).message
    }
  }
  const ranking = computed(() => (rankMutation.isPending.value ? 'pending' : (candidates.value?.ranking.status ?? 'none')))

  return {
    bindings,
    candidates,
    library,
    hasAny,
    saving: computed(() => save.isPending.value),
    error,
    bind,
    unbind,
    rank,
    ranking,
    rankError,
  }
}

export type SuiteFixtures = ReturnType<typeof useSuiteFixtures>
