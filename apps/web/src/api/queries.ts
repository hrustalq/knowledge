// TanStack Query (vue-query) integration for the generated client.
// - Register augmentation makes ApiRequestError THE error type of every
//   useQuery/useMutation in the app (strict error contract on the read side).
// - createQueryClient() is called per app instance (SSR-safe, no cross-request
//   state) from src/main.ts.
import { QueryClient, useMutation, useQueryClient } from '@tanstack/vue-query'
import type { HttpMethod, PathsWithMethod } from 'openapi-typescript-helpers'
import { api, request, type ApiPaths, type Op, type RequestOptions } from './client'
import { isApiRequestError, ApiRequestError } from './http'

declare module '@tanstack/vue-query' {
  interface Register {
    defaultError: ApiRequestError
  }
}

/** Retry transient failures only — 4xx are contract errors, retrying is noise. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (!isApiRequestError(error)) return false
  return error.status >= 500 || error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT'
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
}

/** Abort when EITHER signal aborts. Uses AbortSignal.any when the platform (and TS lib) has it, else bridges through an AbortController. */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([a, b])
  const controller = new AbortController()
  for (const signal of [a, b]) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Spreadable query options for a GET operation:
 *   const { data, error } = useQuery(apiQueryOptions('/v1/documents/{id}', { path: { id } }))
 * queryKey is derived from url + params, so cache identity follows the schema.
 * vue-query's per-query AbortSignal is forwarded to axios, so unmounts /
 * refetches / queryClient.cancelQueries() abort the in-flight HTTP request
 * (an explicit opts.signal is honored too — either aborting cancels).
 */
export function apiQueryOptions<P extends PathsWithMethod<ApiPaths, 'get'>>(
  url: P,
  opts?: RequestOptions<Op<P, 'get'>>,
) {
  return {
    queryKey: [url, opts?.path ?? null, opts?.query ?? null] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.get(url, { ...opts, signal: opts?.signal ? combineSignals(opts.signal, signal) : signal }),
  }
}

/**
 * Spreadable mutation options for a write operation:
 *   const save = useMutation(apiMutationOptions('post', '/v1/documents'))
 *   save.mutate({ body: { … } })
 */
export function apiMutationOptions<M extends HttpMethod, P extends PathsWithMethod<ApiPaths, M>>(
  method: M,
  url: P,
) {
  return {
    mutationKey: [method, url] as const,
    mutationFn: (opts: RequestOptions<Op<P, M>>) => request(method, url, opts),
  }
}

/** One optimistic cache write: `update` runs against the current cached value and is rolled back on error. */
export interface OptimisticPatch {
  queryKey: ReadonlyArray<unknown>
  update: (old: unknown) => unknown
}

export interface OptimisticSpec<TVars> {
  /** Cache patches applied the moment .mutate() is called (in-flight queries on those keys are cancelled first). */
  patches?: (vars: TVars) => ReadonlyArray<OptimisticPatch>
  /** Extra query keys to invalidate once the mutation settles (patched keys are always invalidated). */
  invalidates?: (vars: TVars) => ReadonlyArray<ReadonlyArray<unknown>>
}

/**
 * Optimistic-update mutation composable (call in setup()):
 *   const rename = useApiMutation('patch', '/v1/documents/{id}', {
 *     patches: (vars) => [{
 *       queryKey: ['/v1/documents/{id}', vars.path ?? null, null],
 *       update: (old) => ({ ...(old as object), ...vars.body }),
 *     }],
 *     invalidates: () => [['/v1/documents']],
 *   })
 * Contract: cancel in-flight queries → snapshot → patch; rollback snapshots on
 * error; invalidate on settle so the server truth always wins. Errors are
 * ApiRequestError (strict contract); live WS patches may land meanwhile and
 * are safe — they carry server truth for the same keys.
 */
export function useApiMutation<M extends HttpMethod, P extends PathsWithMethod<ApiPaths, M>>(
  method: M,
  url: P,
  optimistic?: OptimisticSpec<RequestOptions<Op<P, M>>>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [method, url] as const,
    mutationFn: (opts: RequestOptions<Op<P, M>>) => request(method, url, opts),
    onMutate: async (vars: RequestOptions<Op<P, M>>) => {
      const patches = optimistic?.patches?.(vars) ?? []
      await Promise.all(patches.map((p) => queryClient.cancelQueries({ queryKey: p.queryKey as unknown[] })))
      const snapshots = patches.map((p) => ({
        queryKey: p.queryKey,
        data: queryClient.getQueryData(p.queryKey as unknown[]),
      }))
      for (const p of patches) queryClient.setQueryData(p.queryKey as unknown[], p.update)
      return { snapshots }
    },
    onError: (_err, _vars, onMutateResult) => {
      for (const snap of onMutateResult?.snapshots ?? []) {
        queryClient.setQueryData(snap.queryKey as unknown[], snap.data)
      }
    },
    onSettled: (_data, _err, vars) => {
      const keys = [
        ...(optimistic?.patches?.(vars).map((p) => p.queryKey) ?? []),
        ...(optimistic?.invalidates?.(vars) ?? []),
      ]
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key as unknown[] })
    },
  })
}

export { api, isApiRequestError, ApiRequestError }
