// TanStack Query (vue-query) for this app. The option builders, the query
// client and the error type registration are @knowledge/api-client/vue-query's,
// shared with apps/admin (#1236); this file binds them to this app's client and
// adds what only this app has: how fresh each query family stays, and the store
// binding and SSR prefetch below.
import { QueryObserver, type QueryClient } from '@tanstack/vue-query'
import { toRaw } from 'vue'
import { createQueryHelpers, DEFAULT_STALE } from '@knowledge/api-client/vue-query'
import { api, request } from './client'
import { isApiRequestError, ApiRequestError } from './http'

export { createQueryClient, type OptimisticPatch, type OptimisticSpec } from '@knowledge/api-client/vue-query'

declare module 'pinia' {
  export interface PiniaCustomProperties {
    /** This app's query client, installed by main.ts (#472). */
    queryClient: QueryClient
  }
}

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
  '/v1/ai/models/choices': LONG,
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

export const { apiQueryOptions, fetchApi, apiInfiniteQueryOptions, apiMutationOptions, useApiMutation } = createQueryHelpers(
  { api, request },
  { times: queryTimes },
)

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
  rememberForHydration(queryClient, options)

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

/**
 * A read entry-server makes before the render, for a component's `useQuery`
 * (#643). Finished before anything draws, so the server renders with it; and
 * serialized like a store's read, so the client's first render finds the same
 * answer and hydrates without asking. A failure is left for the component to
 * ask again, as it always did.
 */
export async function prefetchForRender(
  queryClient: QueryClient,
  options: { queryKey: ReadonlyArray<unknown>; queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown>; staleTime?: number },
): Promise<void> {
  rememberForHydration(queryClient, options)
  await queryClient.fetchQuery({ ...options, retry: false } as never).catch(() => undefined)
}

function rememberForHydration(queryClient: QueryClient, options: { queryKey: ReadonlyArray<unknown> }) {
  const query = queryClient.getQueryCache().build(queryClient, options as never)
  let hashes = storeHashes.get(queryClient)
  if (!hashes) storeHashes.set(queryClient, (hashes = new Set()))
  hashes.add(query.queryHash)
}

/** Whether entry-server should serialize this query: a store read it, or entry-server did before the render. */
export function isStoreQuery(queryClient: QueryClient, queryHash: string): boolean {
  return storeHashes.get(queryClient)?.has(queryHash) ?? false
}

export { api, isApiRequestError, ApiRequestError }
