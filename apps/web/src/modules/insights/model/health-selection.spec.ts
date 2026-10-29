import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, headerState, prune, selectRow, toggleAll } from './health-selection'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort()

describe('health selection', () => {
  it('a plain click toggles the row and moves the anchor', () => {
    const one = selectRow(EMPTY_SELECTION, 'b', ORDER)
    expect(ids(one)).toEqual(['b'])
    expect(one.anchor).toBe('b')
    const none = selectRow(one, 'b', ORDER)
    expect(ids(none)).toEqual([])
    // Toggling a row off still makes it the anchor: the next shift-click ranges from here.
    expect(none.anchor).toBe('b')
  })

  it('shift-click selects the range from the anchor, in either direction, and keeps the anchor', () => {
    const start = selectRow(EMPTY_SELECTION, 'b', ORDER)
    const down = selectRow(start, 'd', ORDER, { shift: true })
    expect(ids(down)).toEqual(['b', 'c', 'd'])
    expect(down.anchor).toBe('b')
    const up = selectRow(down, 'a', ORDER, { shift: true })
    expect(ids(up)).toEqual(['a', 'b', 'c', 'd'])
    expect(up.anchor).toBe('b')
  })

  it('shift-click adds to the selection and never removes', () => {
    const picked = selectRow(selectRow(EMPTY_SELECTION, 'e', ORDER), 'a', ORDER, { meta: true })
    const ranged = selectRow(picked, 'c', ORDER, { shift: true })
    expect(ids(ranged)).toEqual(['a', 'c', 'd', 'e'])
  })

  it('shift-click with no anchor, or an anchor no longer drawn, is a plain click', () => {
    expect(ids(selectRow(EMPTY_SELECTION, 'c', ORDER, { shift: true }))).toEqual(['c'])
    const stale = { ids: new Set(['z']), anchor: 'z' }
    const next = selectRow(stale, 'c', ORDER, { shift: true })
    expect(ids(next)).toEqual(['c', 'z'])
    expect(next.anchor).toBe('c')
  })

  it('meta-click toggles without moving the anchor', () => {
    const start = selectRow(EMPTY_SELECTION, 'a', ORDER)
    const added = selectRow(start, 'd', ORDER, { meta: true })
    expect(ids(added)).toEqual(['a', 'd'])
    expect(added.anchor).toBe('a')
    const removed = selectRow(added, 'a', ORDER, { meta: true })
    expect(ids(removed)).toEqual(['d'])
    expect(removed.anchor).toBe('a')
  })

  it('toggleAll selects every drawn row, then none once they all are', () => {
    const some = selectRow(EMPTY_SELECTION, 'b', ORDER)
    const all = toggleAll(some, ORDER)
    expect(ids(all)).toEqual(ORDER)
    expect(headerState(all, ORDER)).toBe('all')
    const none = toggleAll(all, ORDER)
    expect(ids(none)).toEqual([])
    expect(none.anchor).toBeNull()
    expect(toggleAll(EMPTY_SELECTION, [])).toEqual({ ids: new Set(), anchor: null })
  })

  it('prune drops rows that are no longer drawn, and the anchor with them', () => {
    const all = toggleAll(selectRow(EMPTY_SELECTION, 'e', ORDER), ORDER)
    const fewer = prune(all, ['a', 'c'])
    expect(ids(fewer)).toEqual(['a', 'c'])
    expect(fewer.anchor).toBeNull()
    // Nothing to drop returns the same value, so a watcher does not churn.
    expect(prune(fewer, ['a', 'c', 'x'])).toBe(fewer)
  })

  it('headerState reads none / some / all', () => {
    expect(headerState(EMPTY_SELECTION, ORDER)).toBe('none')
    expect(headerState(selectRow(EMPTY_SELECTION, 'a', ORDER), ORDER)).toBe('some')
    expect(headerState({ ids: new Set(['zz']), anchor: null }, ORDER)).toBe('none')
    expect(headerState(toggleAll(EMPTY_SELECTION, ORDER), ORDER)).toBe('all')
  })
})
