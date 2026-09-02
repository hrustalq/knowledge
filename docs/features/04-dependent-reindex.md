# 04 — Auto re-index of dependent documents + live frontend updates

> Оригинал: «Автоматический ре-индекс зависимых документов при обновлении (при
> мерже) — Обновление данных на фронте (инвалидация кеша, уведомления)»

## What it is

When a document is (re)indexed — including after a merge, which runs the normal
finalize → outbox → index pipeline — documents that depend on it are re-indexed
automatically, and the frontend hears about all of it in real time.

## Design

### Dependent re-index (worker)

After the ingestion processor marks a revision `indexed`, it walks the
workspace relation graph (already loaded per-workspace via
`GraphService.getWorkspaceRelationGraph`):

1. entities this document points at with `DESCRIBES` edges (what the doc
   defines);
2. other documents with any relation edge to those entities — those are the
   dependents;
3. for each dependent (cap: `DEPENDENT_REINDEX_MAX`, default 20) enqueue a
   `reindex` ingestion job for its default-branch head.

Loop protection: cascade jobs carry `payload.reason = 'dependent-reindex'` and
the processor **does not cascade from such jobs** — one level of fan-out per
user-triggered index, no transitive storms. Enqueueing is non-fatal (same
posture as fulltext/inference steps).

### Live events (Redis pub/sub → SSE)

- Channel `knowledge:events`, JSON payloads
  `{ type, workspaceId, documentId?, revisionId?, title?, at }`.
- **Publishers**: the worker (`revision.indexed`, `revision.failed`,
  `revision.dependent-reindex`) and the API's `ActivityService` (feature 10 —
  every recorded activity is also published, e.g. `document.created`,
  `merge-request.merged`).
- **Subscriber**: `EventsModule` in the API holds one Redis subscriber
  connection and fans out to an in-process RxJS subject.
  `GET /v1/events?workspaceId=` is an SSE endpoint (`@Sse`) filtered by
  workspace.
- **Web**: `useEventsStore` opens one `EventSource` per session; on
  `revision.indexed` it invalidates the documents store, refreshes the open
  document page and raises a toast. No more blind 2s polling loops.

## Notes

- SSE + `AUTH_MODE=api-key`: `EventSource` cannot set headers; the endpoint
  accepts the key via `?token=` as well (resolved by the same guard path).
- Events are best-effort delivery (no replay); the UI still refetches on
  navigation, so a missed event never corrupts state.

## Future work

- Transitive cascades with depth budget + cycle detection.
- Event replay via Redis streams for reconnecting clients.
