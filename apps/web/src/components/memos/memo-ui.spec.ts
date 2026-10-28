import { describe, expect, it } from 'vitest'
import { memoClock } from '@knowledge/contracts'
import { isMemoInFlight, segmentAt } from './memo-ui'

describe('memo-ui', () => {
  const segments = [
    { i: 0, start: 0.4, end: 4 },
    { i: 1, start: 7.3, end: 12 },
    { i: 2, start: 61, end: 70 },
  ]

  it('finds the line under the playhead, holding the last one through a pause between lines', () => {
    expect(segmentAt(segments, 0)).toBeNull()
    expect(segmentAt(segments, 0.4)).toBe(0)
    expect(segmentAt(segments, 5)).toBe(0)
    expect(segmentAt(segments, 22)).toBe(1)
    expect(segmentAt(segments, 3600)).toBe(2)
  })

  it('polls only while a memo is still moving', () => {
    expect(['pending', 'uploaded', 'transcribing', 'transcribed', 'analysing'].every((s) => isMemoInFlight(s as never))).toBe(true)
    expect(isMemoInFlight('done')).toBe(false)
    expect(isMemoInFlight('failed')).toBe(false)
  })

  it('spells a moment the way the merge request links do', () => {
    expect(memoClock(61.9)).toBe('1:01')
    expect(memoClock(3725)).toBe('1:02:05')
  })
})
