// TanStack Query (vue-query) integration for the generated client.
// - Register augmentation makes ApiRequestError THE error type of every
//   useQuery/useMutation in the app (strict error contract on the read side).
// - createQueryClient() is called per app instance (SSR-safe, no cross-request
//   state) from src/main.ts.
import { QueryClient, QueryObserver, useMutation, useQueryClient } from '@tanstack/vue-query'
import { toRaw } from 'vue'
import type { HttpMethod, PathsWithMethod } from 'openapi-typescript-helpers'
import { api, request, type ApiPaths, type Op, type RequestOptions } from './client'
import { isApiRequestError, ApiRequestError } from './http'

declare module '@tanstack/vue-query' {
  interface Register {
    defaultError: ApiRequestError
  }
}

declare module 'pinia' {
  export interface PiniaCustomProperties {
    /** This app's query client, installed by main.ts (#472). */
    queryClient: QueryClient
  }
}

/** Retry transient failures only — 4xx are contract errors, retrying is noise. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (!isApiRequestError(error)) return false
  return error.status >= 500 || error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT'
}

/** Everything without a family below: lists, pages, threads — anything a peer's write moves. */
const DEFAULT_STALE = 30_000
const LONG = 5 * 60_000
/** Addressed by an immutable id: the answer can never change, only be evicted. */
const FOREVER = { staleTime: Infinity, gcTime: 30 * 60_000 }

/**
 * Freshness per query family (#472), the one place it is decided. Rosters,
 * catalogues and settings change when an admin edits them — and the edit
 * invalidates its own key — so they are kept long; anything else stays at
 * the default. Keyed by the url template, which is the query key's head.
 */
const FAMILY_STALE: Record<string, number> = {
  '/v1/me': LONG,
  '/v1/workspaces': LONG,
  '/v1/projects': LONG,
  '/v1/glossary': LONG,
  '/v1/workflows': LONG,
  '/v1/templates': LONG,
  '/v1/ai/agents/choices': LONG,
  '/v1/ai/providers/choices': LONG,
  '/v1/ai/skills': LONG,
  '/v1/ai/settings': LONG,
  '/v1/lint-policy': LONG,
  '/v1/knowledge-health/settings': LONG,
  '/v1/chat/search-settings': LONG,
  '/v1/analytics/settings': LONG,
  '/v1/workspaces/{id}/api-settings': LONG,
  '/v1/workspaces/{id}/publishing-settings': LONG,
  '/v1/workspaces/{id}/auth-policy': LONG,
}

/** staleTime/gcTime for one query, from its url template and query params. */
export function queryTimes(url: string, query?: unknown): { staleTime: number; gcTime?: number } {
  // A page's content at a named revision, a template at a numbered version.
  if (url === '/v1/documents/{id}/content' && (query as { revision?: string } | null)?.revision) return FOREVER
  if (url === '/v1/templates/{id}/versions/{version}') return FOREVER
  return { staleTime: FAMILY_STALE[url] ?? DEFAULT_STALE }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE,
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
    ...queryTimes(url, opts?.query),
  }
}

/**
 * An imperative read through the cache (#472) — a store action, a route
 * guard, a component's `load()`. It shares the key, and so the answer, with
 * every `useQuery` on the same url and params, joins a request already in
 * flight, and answers from the cache while the family's staleTime holds.
 * `{ fresh: true }` after a write, when the cached answer is known to be old.
 */
export function fetchApi<P extends PathsWithMethod<ApiPaths, 'get'>>(
  queryClient: QueryClient,
  url: P,
  opts?: RequestOptions<Op<P, 'get'>>,
  { fresh = false }: { fresh?: boolean } = {},
) {
  // No retry: the caller owns its failure (a Retry button, a toast), and two
  // silent retries would hold an error state back for seconds.
  return queryClient.fetchQuery({ ...apiQueryOptions(url, opts), retry: false, ...(fresh ? { staleTime: 0 } : {}) })
}

/** One observer per store and slot — see bindStoreQuery. Keyed by `toRaw(store)` for the reason stores/documents.ts gives (#279). */
const storeObservers = new WeakMap<object, Map<string, QueryObserver>>()
/** Query hashes a store read during this app's life; entry-server serializes only these. */
const storeHashes = new WeakMap<QueryClient, Set<string>>()

/**
 * Back a store's copy of server data by one query (#472): the store keeps its
 * shape and API, but the answer lives in the cache under the same key every
 * `useQuery` uses, so the two can never disagree.
 *
 * On the client a QueryObserver keeps the query active, which is what makes a
 * live-cache invalidation refetch it — and `apply` writes each new answer
 * back into the store. Rebinding the same slot with another key (a project
 * switch) moves the observer rather than adding one. On the server there is
 * nothing to observe: one fetch, and the key is remembered so entry-server can
 * hand the answer to the client, which then binds without asking again.
 */
export async function bindStoreQuery<T>(
  store: object,
  slot: string,
  queryClient: QueryClient,
  options: { queryKey: ReadonlyArray<unknown>; queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown>; staleTime?: number },
  apply: (data: T) => void,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<void> {
  const query = queryClient.getQueryCache().build(queryClient, options as never)
  let hashes = storeHashes.get(queryClient)
  if (!hashes) storeHashes.set(queryClient, (hashes = new Set()))
  hashes.add(query.queryHash)

  if (!import.meta.env.SSR) {
    const raw = toRaw(store)
    let slots = storeObservers.get(raw)
    if (!slots) storeObservers.set(raw, (slots = new Map()))
    // A refetch the observer itself starts must not race the fetch below.
    const observed = { ...options, refetchOnMount: false } as never
    const observer = slots.get(slot)
    if (observer) observer.setOptions(observed)
    else {
      const created = new QueryObserver(queryClient, observed)
      let last: unknown
      created.subscribe((result) => {
        if (result.status !== 'success' || result.data === last) return
        last = result.data
        apply(result.data as T)
      })
      slots.set(slot, created)
    }
  }
  apply((await queryClient.fetchQuery({ ...options, retry: false, ...(fresh ? { staleTime: 0 } : {}) } as never)) as T)
}

/** Stop following a slot — a scope change that is not refetching it, so it must not keep writing the old scope's answer back. */
export function unbindStoreQuery(store: object, slot: string): void {
  const slots = storeObservers.get(toRaw(store))
  slots?.get(slot)?.destroy()
  slots?.delete(slot)
}

/** Whether entry-server should serialize this query: a store read it before or during the render. */
export function isStoreQuery(queryClient: QueryClient, queryHash: string): boolean {
  return storeHashes.get(queryClient)?.has(queryHash) ?? false
}

/**
 * Spreadable `useInfiniteQuery` options for a GET that pages by `cursor` and
 * answers with `nextCursor`:
 *   useInfiniteQuery(apiInfiniteQueryOptions('/v1/connectors/{id}/runs', { path: { id } }))
 * The key carries a trailing `'pages'` so the paged cache entry never collides
 * with a plain `apiQueryOptions` entry for the same url — the two hold different
 * shapes — while an invalidation by url prefix still reaches both.
 */
export function apiInfiniteQueryOptions<P extends PathsWithMethod<ApiPaths, 'get'>>(
  url: P,
  opts?: RequestOptions<Op<P, 'get'>>,
) {
  return {
    queryKey: [url, opts?.path ?? null, opts?.query ?? null, 'pages'] as const,
    queryFn: ({ signal, pageParam }: { signal: AbortSignal; pageParam: string | null }) =>
      api.get(url, {
        ...opts,
        query: { ...opts?.query, ...(pageParam ? { cursor: pageParam } : {}) } as RequestOptions<Op<P, 'get'>>['query'],
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: unknown) => (last as { nextCursor?: string | null }).nextCursor ?? null,
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
