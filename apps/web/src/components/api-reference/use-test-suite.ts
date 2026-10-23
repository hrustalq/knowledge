import { computed, ref, watch, type Ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { AgentRunSummary, ApiTestSuiteResponse, GenerateApiTestSuiteResponse } from '@knowledge/contracts'
import { apiQueryOptions, isApiRequestError, useApiMutation } from '@/api/queries'

const POLL_MS = 2_500

const finished = (r: AgentRunSummary | undefined) =>
  !!r && (r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled')

/**
 * One operation's QA test suite (#468): the cached suite, read only while the
 * card is open, and Generate — which answers from the cache when it can, and
 * otherwise polls the `tester` run it started (the drift check's pattern)
 * and reads the suite again once that run succeeds.
 */
export function useTestSuite(workspaceId: () => string, documentId: () => string, entityKey: () => string, active: Ref<boolean>) {
  const client = useQueryClient()
  const options = computed(() =>
    apiQueryOptions('/v1/api-specs/{id}/test-suite', { path: { id: documentId() }, query: { entityKey: entityKey() } }),
  )
  const suiteQuery = useQuery(computed(() => ({ ...options.value, enabled: active.value, retry: false, staleTime: Infinity })))
  const suite = computed(() => suiteQuery.data.value as ApiTestSuiteResponse | undefined)
  /** A 404 is "not generated yet", not an error. */
  const loadError = computed(() => {
    const e = suiteQuery.error.value
    return e && !(isApiRequestError(e) && e.status === 404) ? e.message : null
  })

  const runId = ref<string | null>(null)
  const runQuery = useQuery(
    computed(() => ({
      // The spec's workspace, which owns the run — not whichever one is selected.
      ...apiQueryOptions('/v1/ai/agents/runs/{id}', { path: { id: runId.value ?? '' }, query: { workspaceId: workspaceId() } }),
      enabled: !!runId.value,
      refetchInterval: (q: { state: { data: unknown } }) => (finished(q.state.data as AgentRunSummary | undefined) ? false : POLL_MS),
    })),
  )
  const run = computed(() => (runId.value ? (runQuery.data.value as AgentRunSummary | undefined) : undefined))
  watch(
    () => run.value?.status,
    (status) => {
      if (status === 'succeeded') void suiteQuery.refetch()
    },
  )

  const start = useApiMutation('post', '/v1/api-specs/{id}/test-suite')
  const startError = ref<string | null>(null)
  const generating = computed(() => start.isPending.value || (!!runId.value && !finished(run.value)))
  const failure = computed(() => {
    if (startError.value) return startError.value
    const r = run.value
    return r && finished(r) && r.status !== 'succeeded' ? (r.error ?? '') : null
  })

  async function generate(regenerate = false) {
    startError.value = null
    runId.value = null
    try {
      const res = (await start.mutateAsync({
        path: { id: documentId() },
        body: { entityKey: entityKey(), regenerate },
      })) as GenerateApiTestSuiteResponse
      if (res.suite) client.setQueryData(options.value.queryKey, res.suite)
      else runId.value = res.runId
    } catch (e) {
      startError.value = (e as Error).message
    }
  }

  return { suite, loadError, generating, failure, generate, queryKey: () => options.value.queryKey }
}
