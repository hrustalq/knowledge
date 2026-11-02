import { describe, expect, it } from 'vitest'
import { relocateLines } from './anchor-match'

// #708: a pinned passage, re-found on a newer head.
describe('relocateLines', () => {
  const v1 = '# Runbook\n\nIntro.\n\n- check the queue\n- drain it\n\nOutro.'

  it('follows a passage pushed down by an insert above it', () => {
    const v2 = '# Runbook\n\nIntro.\n\nA new paragraph,\nover two lines.\n\n- check the queue\n- drain it\n\nOutro.'
    expect(relocateLines(v1, v2, { start: 5, end: 6 })).toEqual({ start: 8, end: 9 })
  })

  it('is null once the passage is deleted or rewritten', () => {
    expect(relocateLines(v1, '# Runbook\n\nIntro.\n\nOutro.', { start: 5, end: 6 })).toBeNull()
    expect(relocateLines(v1, v1.replace('drain it', 'restart it'), { start: 5, end: 6 })).toBeNull()
  })

  it('picks the repeat whose surroundings match', () => {
    const twice = 'A\n\nsame line\n\nB\n\nsame line\n\nC'
    expect(relocateLines(twice, `X\n\n${twice}`, { start: 7, end: 7 })).toEqual({ start: 9, end: 9 })
  })
})
