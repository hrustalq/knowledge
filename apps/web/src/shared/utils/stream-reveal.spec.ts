import { describe, expect, it } from 'vitest'
import { REVEAL_MS, createRevealTracker } from './stream-reveal'

describe('createRevealTracker', () => {
  it('marks only the characters past what was already shown', () => {
    const reveal = createRevealTracker()
    expect(reveal.advance(5, 0)).toEqual([{ start: 0, end: 5, at: 0 }])
    expect(reveal.advance(12, 100)).toEqual([
      { start: 0, end: 5, at: 0 },
      { start: 5, end: 12, at: 100 },
    ])
  })

  it('drops a run once its entrance has finished', () => {
    const reveal = createRevealTracker()
    reveal.advance(5, 0)
    expect(reveal.advance(9, REVEAL_MS + 1)).toEqual([{ start: 5, end: 9, at: REVEAL_MS + 1 }])
  })

  it('does not replay text that shrank while syntax resolved', () => {
    const reveal = createRevealTracker()
    reveal.advance(10, 0)
    // `**bold**` rendering: two characters of markup vanish.
    expect(reveal.advance(8, 50)).toEqual([{ start: 0, end: 10, at: 0 }])
    expect(reveal.advance(11, 80).at(-1)).toEqual({ start: 10, end: 11, at: 80 })
  })

  it('starts over after a reset', () => {
    const reveal = createRevealTracker()
    reveal.advance(10, 0)
    reveal.reset()
    expect(reveal.advance(3, 10)).toEqual([{ start: 0, end: 3, at: 10 }])
  })
})
