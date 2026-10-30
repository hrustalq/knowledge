/**
 * The reads a page view waits on before it can draw (#628), in one place so the
 * page and a hover prefetch build the same cache keys — a key that differs by
 * one `{}` is a prefetch nobody reads.
 */
import type { QueryClient } from '@tanstack/vue-query'
import { apiQueryOptions } from '@/shared/api/queries'

/** Which content a view reads: a named revision, the page as of a date or tag, or the default head. */
export type ContentAt = { revision: string } | { asOf: string } | null

/**
 * One entry per view, so `?revision=`, `?asOf=` and the head never share one.
 * `?branch=` reads the head: the content route takes no branch.
 */
export const documentContentQuery = (id: string, at: ContentAt) =>
  apiQueryOptions('/v1/documents/{id}/content', { path: { id }, ...(at ? { query: at } : {}) })

export const documentDetailQuery = (id: string) => apiQueryOptions('/v1/documents/{id}', { path: { id } })

/**
 * The detail and the head's content, through the same route and scope as the
 * click. A refusal is cached as an error and asked again on mount, so the page
 * reports it as it always has; nothing here is shown.
 */
export function prefetchDocument(queryClient: QueryClient, id: string): Promise<unknown> {
  const swallow = () => undefined
  return Promise.all([
    queryClient.query(documentDetailQuery(id)).catch(swallow),
    queryClient.query(documentContentQuery(id, null)).catch(swallow),
  ])
}
