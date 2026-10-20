import { describe, expect, it } from 'vitest'
import { BEAT_MS, createPageViewTracker, IDLE_MS, searchClickOf, TICK_MS } from './page-view'

const SID = '55555555-5555-4555-8555-555555555555'

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(noTrack = false) {
  const sent: { path: string; body: Record<string, unknown> }[] = []
  const opened: string[] = []
  const state = { now: 0, visible: true, ids: 0, fail: false }
  const tracker = createPageViewTracker({
    send: (path, body) => {
      sent.push({ path, body })
      return state.fail ? Promise.reject(new Error('403 Forbidden')) : Promise.resolve()
    },
    opened: (id) => opened.push(id),
    visible: () => state.visible,
    now: () => state.now,
    newId: () => `v-${++state.ids}`,
    noTrack,
  })
  /** Advance `ms` of wall time, one timer tick per second, with input every tick unless `idle`. */
  const pass = (ms: number, idle = false) => {
    for (let t = 0; t < ms; t += TICK_MS) {
      state.now += TICK_MS
      if (!idle) tracker.input()
      tracker.tick()
    }
  }
  const beats = () => sent.filter((s) => s.path.endsWith('/heartbeat')).map((s) => s.body.activeMs)
  return { tracker, sent, opened, state, pass, beats }
}

describe('page-view tracker (#79)', () => {
  it('opens one view per page, carrying the search click, and reports time every 15 s', () => {
    const h = harness()
    h.tracker.open({ documentId: 'd-1', revisionId: 'r-1', searchId: SID, searchRank: 3 })
    h.tracker.open({ documentId: 'd-1', revisionId: 'r-2' }) // a re-render, not a new view
    expect(h.sent).toEqual([
      { path: '/v1/documents/d-1/views', body: { viewId: 'v-1', revisionId: 'r-1', searchId: SID, searchRank: 3 } },
    ])
    h.pass(60_000)
    expect(h.beats()).toEqual([15_000, 30_000, 45_000, 60_000])
    expect(h.sent.at(-1)?.path).toBe('/v1/analytics/views/v-1/heartbeat')
  })

  it('reports each opened view once its beacon is accepted, never for a heartbeat or a failure (#336)', async () => {
    const h = harness()
    h.tracker.open({ documentId: 'd-1', revisionId: null })
    h.tracker.open({ documentId: 'd-1', revisionId: 'r-2' }) // the same view
    h.pass(BEAT_MS * 3)
    await flushPromises()
    expect(h.opened).toEqual(['d-1'])

    h.state.fail = true
    h.tracker.open({ documentId: 'd-2', revisionId: null })
    h.pass(BEAT_MS)
    await flushPromises()
    expect(h.opened).toEqual(['d-1'])

    h.state.fail = false
    h.tracker.open({ documentId: 'd-3', revisionId: null })
    await flushPromises()
    expect(h.opened).toEqual(['d-1', 'd-3'])
  })

  it('accrues nothing while the tab is hidden', () => {
    const h = harness()
    h.tracker.open({ documentId: 'd-1', revisionId: null })
    h.pass(10_000)
    h.state.visible = false
    h.pass(BEAT_MS * 4)
    h.state.visible = true
    h.pass(5_000)
    h.tracker.flush()
    expect(h.beats().at(-1)).toBe(15_000)
  })

  it('stops counting once the reader has been idle for 30 s', () => {
    const h = harness()
    h.tracker.open({ documentId: 'd-1', revisionId: null })
    h.pass(5 * 60_000, true)
    h.tracker.flush()
    expect(h.beats().at(-1)).toBe(IDLE_MS - TICK_MS)
  })

  it('flushes on close (pagehide, leaving the page) and sends nothing when nothing changed', () => {
    const h = harness()
    h.tracker.open({ documentId: 'd-1', revisionId: null })
    h.pass(7_000)
    h.tracker.close()
    expect(h.beats()).toEqual([7_000])
    h.tracker.flush()
    h.tracker.open({ documentId: 'd-2', revisionId: null })
    h.tracker.flush()
    expect(h.beats()).toEqual([7_000])
    expect(h.sent.at(-1)?.body.viewId).toBe('v-2')
  })

  it('marks every beacon under DNT / GPC', () => {
    const h = harness(true)
    h.tracker.open({ documentId: 'd-1', revisionId: null })
    h.pass(BEAT_MS)
    expect(h.sent.every((s) => s.body.noTrack === true)).toBe(true)
  })

  it('takes a search click only when both parts are well-formed', () => {
    expect(searchClickOf(SID, '3')).toEqual({ searchId: SID, searchRank: 3 })
    expect(searchClickOf('nope', '3')).toBeNull()
    expect(searchClickOf(SID, '0')).toBeNull()
    expect(searchClickOf(SID, undefined)).toBeNull()
    expect(searchClickOf([SID], '1')).toBeNull()
  })
})
