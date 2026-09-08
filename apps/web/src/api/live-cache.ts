// Live data patching: binds LiveClient events to the vue-query cache so
// tracked entities update on screen without a refetch. Two mechanisms:
//  - patch: events carrying `patch` (e.g. document.updated) are shallow-merged
//    into every cached query for that entity — instant, no network.
//  - invalidate: everything else marks the mapped query keys stale, letting
//    vue-query refetch what is actually on screen.
// Rules are data ("tracking configuration" client-side) — extend or replace
// them per app via startLive({ rules }).
import type { QueryClient } from '@tanstack/vue-query'
import type { KnowledgeEvent, LiveTrackingConfig } from '@knowledge/contracts'
import { getWorkspaceId } from '@/lib/api'
import { LiveClient } from './live'

export interface LiveCacheRule {
  /** Event type to react to — exact ('document.updated') or glob prefix ('revision.*'). */
  on: string
  /** Query-key prefixes to invalidate (matched with startsWith semantics by vue-query). */
  invalidate?: (event: KnowledgeEvent) => ReadonlyArray<ReadonlyArray<unknown>>
  /** Live patch: applied to the cache immediately (before any refetch). */
  patch?: (event: KnowledgeEvent, queryClient: QueryClient) => void
}

function matchesType(pattern: string, type: string): boolean {
  return pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)))
}

/** Shallow-merge an event patch into every cached detail query of a document. */
function patchDocumentQueries(event: KnowledgeEvent, queryClient: QueryClient): void {
  if (!event.patch || !event.documentId) return
  queryClient.setQueriesData(
    {
      predicate: (query) => {
        const [url, path] = query.queryKey as [unknown, unknown, unknown]
        return (
          typeof url === 'string' &&
          url.startsWith('/v1/documents/{') &&
          typeof path === 'object' &&
          path !== null &&
          (path as Record<string, unknown>).id === event.documentId
        )
      },
    },
    (old: unknown) => {
      if (typeof old !== 'object' || old === null) return old
      // Merge into the entity wherever the response nests it.
      const record = old as Record<string, unknown>
      if (typeof record.document === 'object' && record.document !== null) {
        return { ...record, document: { ...(record.document as object), ...event.patch } }
      }
      return { ...record, ...event.patch }
    },
  )
}

/** Default tracking rules for the knowledge platform's event vocabulary. */
export const defaultLiveCacheRules: LiveCacheRule[] = [
  {
    on: 'document.updated',
    patch: patchDocumentQueries,
    invalidate: () => [['/v1/documents'], ['/v1/documents/tree']],
  },
  { on: 'document.*', invalidate: () => [['/v1/documents'], ['/v1/documents/tree']] },
  {
    on: 'revision.*',
    invalidate: (e) => [
      ['/v1/documents'],
      ...(e.documentId
        ? [
            ['/v1/documents/{id}', { id: e.documentId }],
            ['/v1/documents/{id}/revisions', { id: e.documentId }],
            ['/v1/documents/{id}/content', { id: e.documentId }],
            ['/v1/documents/{id}/graph', { id: e.documentId }],
          ]
        : []),
    ],
  },
  {
    // subjectId carries the merge-request id on every merge-request.* event.
    on: 'merge-request.*',
    invalidate: (e) => [
      ['/v1/merge-requests'],
      ...(e.subjectId
        ? [
            ['/v1/merge-requests/{id}', { id: e.subjectId }],
            ['/v1/merge-requests/{id}/diff', { id: e.subjectId }],
            ['/v1/merge-requests/{id}/threads', { id: e.subjectId }],
          ]
        : []),
      ...(e.documentId ? [['/v1/documents/{id}/merge-requests', { id: e.documentId }]] : []),
    ],
  },
  {
    // subjectId carries the run id on every workflow-run.*/workflow-node.* event.
    // A run's node tree changes far more often than the run row itself, so the
    // detail query is invalidated on node events too.
    on: 'workflow-run.*',
    invalidate: (e) => [
      ['/v1/workflows/runs'],
      ...(e.subjectId ? [['/v1/workflows/runs/{id}', { id: e.subjectId }]] : []),
      ...(e.documentId ? [['/v1/documents/{id}/workflow-runs', { id: e.documentId }]] : []),
    ],
  },
  {
    on: 'workflow-node.*',
    invalidate: (e) => [
      ['/v1/workflows/runs'],
      ...(e.subjectId ? [['/v1/workflows/runs/{id}', { id: e.subjectId }]] : []),
      ...(e.documentId ? [['/v1/documents/{id}/workflow-runs', { id: e.documentId }]] : []),
    ],
  },
  { on: 'workflow.*', invalidate: () => [['/v1/workflows']] },
  // A project rename/delete changes the switcher, and re-scopes the page tree.
  { on: 'project.*', invalidate: () => [['/v1/projects'], ['/v1/documents'], ['/v1/documents/tree']] },
  { on: 'relations.*', invalidate: (e) => [['/v1/entities'], ...(e.documentId ? [['/v1/documents/{id}/graph', { id: e.documentId }]] : [])] },
  { on: 'branch.created', invalidate: (e) => (e.documentId ? [['/v1/documents/{id}', { id: e.documentId }]] : []) },
  { on: '*', invalidate: () => [['/v1/activity']] },
]

/** Apply every matching rule for one event. */
export function applyLiveEvent(event: KnowledgeEvent, queryClient: QueryClient, rules: LiveCacheRule[]): void {
  for (const rule of rules) {
    if (!matchesType(rule.on, event.type)) continue
    rule.patch?.(event, queryClient)
    for (const key of rule.invalidate?.(event) ?? []) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }
}

let singleton: LiveClient | null = null
let unbind: (() => void) | null = null

export interface StartLiveOptions {
  queryClient: QueryClient
  /** Per-subscription tracking configuration sent to the server (events/documents filters). */
  tracking?: LiveTrackingConfig
  /** Cache rules; defaults to defaultLiveCacheRules. */
  rules?: LiveCacheRule[]
  /** Workspace to track; defaults to the active workspace. */
  workspaceId?: string
}

/**
 * Idempotent bootstrap: connect the singleton LiveClient, bind it to the
 * query cache and subscribe to the workspace. Call once the user is
 * authenticated (App.vue); call again with a different tracking config to
 * retune the subscription live.
 */
export function startLive(options: StartLiveOptions): LiveClient {
  if (import.meta.env.SSR) throw new Error('startLive is client-only')
  const rules = options.rules ?? defaultLiveCacheRules
  if (!singleton) singleton = new LiveClient()
  unbind?.()
  unbind = singleton.onEvent((event) => applyLiveEvent(event, options.queryClient, rules))
  singleton.connect()
  singleton.subscribe(options.workspaceId ?? getWorkspaceId(), options.tracking)
  return singleton
}

export function stopLive(): void {
  unbind?.()
  unbind = null
  singleton?.close()
  singleton = null
}

export function liveClient(): LiveClient | null {
  return singleton
}
