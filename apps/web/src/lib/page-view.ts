// The page-view beacon's bookkeeping (#79), store- and DOM-free so it can be
// tested as plain code. use-page-view.ts wires it to the page, the browser
// and the API.

export interface PageViewTarget {
  documentId: string
  revisionId: string | null
  /** The search result the page was opened from, and its 1-based rank. */
  searchId?: string
  searchRank?: number
}

export interface PageViewDeps {
  /** POST; settles once the API answered, and rejects on a refusal or a network failure. */
  send(path: string, body: Record<string, unknown>): Promise<unknown>
  /**
   * The open beacon for `documentId` was accepted — the view is now a row, so a
   * count read after this includes it (#336). Never called for a heartbeat or a
   * failed beacon.
   */
  opened?(documentId: string): void
  visible(): boolean
  now(): number
  newId(): string
  /** DNT / Global Privacy Control: counted, never tied to a reader. */
  noTrack: boolean
}

const noop = () => {}

export const TICK_MS = 1_000
/** How often a reading tab reports its time. */
export const BEAT_MS = 15_000
/** No scroll, key or pointer for this long and the reader has stepped away. */
export const IDLE_MS = 30_000

/**
 * One open view at a time. Active time grows only while the tab is visible
 * and the reader did something in the last 30 s; it is sent as a running
 * total, so a lost or late beat is made good by the next.
 */
export function createPageViewTracker(deps: PageViewDeps) {
  let view: { id: string; documentId: string } | null = null
  let active = 0
  let sent = 0
  let sinceBeat = 0
  let lastInput = 0
  const privacy = deps.noTrack ? { noTrack: true } : {}

  function flush() {
    if (!view || active <= sent) return
    sent = active
    deps.send(`/v1/analytics/views/${view.id}/heartbeat`, { activeMs: active, ...privacy }).catch(noop)
  }

  function close() {
    flush()
    view = null
  }

  /** Start a view of `t`, closing the last one; the same page again is not a new view. */
  function open(t: PageViewTarget) {
    if (view?.documentId === t.documentId) return
    close()
    const { documentId } = t
    view = { id: deps.newId(), documentId }
    active = sent = sinceBeat = 0
    lastInput = deps.now()
    deps
      .send(`/v1/documents/${documentId}/views`, {
        viewId: view.id,
        ...(t.revisionId ? { revisionId: t.revisionId } : {}),
        ...(t.searchId ? { searchId: t.searchId } : {}),
        ...(t.searchRank ? { searchRank: t.searchRank } : {}),
        ...privacy,
      })
      .then(() => deps.opened?.(documentId), noop)
  }

  function tick() {
    if (!view) return
    if (deps.visible() && deps.now() - lastInput < IDLE_MS) active += TICK_MS
    sinceBeat += TICK_MS
    if (sinceBeat >= BEAT_MS) {
      sinceBeat = 0
      flush()
    }
  }

  return {
    open,
    close,
    flush,
    tick,
    input: () => {
      lastInput = deps.now()
    },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** `?sid=&rank=` from a search result link, or nothing when either is malformed. */
export function searchClickOf(sid: unknown, rank: unknown): { searchId: string; searchRank: number } | null {
  const n = Number(rank)
  if (typeof sid !== 'string' || !UUID.test(sid) || !Number.isInteger(n) || n < 1 || n > 1000) return null
  return { searchId: sid, searchRank: n }
}
