import { describe, expect, it } from 'vitest'
import { HOME_WIDGETS, homeLayoutOf } from '@knowledge/contracts'
import { moveWidget, slotsFor, toggleWidget } from './layout-draft'

describe('home layout draft (#1243)', () => {
  it('moves within a zone and stops at its ends', () => {
    const all = [...HOME_WIDGETS]
    expect(moveWidget(all, 'recent', -1)).toEqual(['metrics', 'actions', 'recent', 'needs-you', 'activity', 'agents'])
    // `needs-you` leads the main zone: the side zone's widgets are not its neighbours.
    expect(moveWidget(all, 'needs-you', -1)).toEqual(all)
    expect(moveWidget(all, 'recent', 1)).toEqual(all)
  })

  it('hides, then shows a widget last in its zone', () => {
    const hidden = toggleWidget([...HOME_WIDGETS], 'needs-you')
    expect(hidden).not.toContain('needs-you')
    expect(slotsFor(hidden, 'main')).toEqual(['recent', 'needs-you'])
    expect(toggleWidget(hidden, 'needs-you').filter((w) => w === 'recent' || w === 'needs-you')).toEqual(['recent', 'needs-you'])
  })

  it('reads anything but a list as the default, and drops unknown keys', () => {
    expect(homeLayoutOf(null)).toEqual([...HOME_WIDGETS])
    expect(homeLayoutOf(['agents', 'nope', 'agents', 'metrics'])).toEqual(['agents', 'metrics'])
    expect(homeLayoutOf([])).toEqual([])
  })
})
