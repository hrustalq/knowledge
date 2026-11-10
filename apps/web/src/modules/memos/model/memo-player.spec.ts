import { describe, expect, it } from 'vitest'
import { memoBars } from './memo-player'

describe('memoBars', () => {
  it('draws the same strip for the same memo, a different one for another, and no bar too short to see', () => {
    const a = memoBars('6c598bc8-e4b8-4de5-9bc0-ad3e7064cbd0')
    expect(a).toEqual(memoBars('6c598bc8-e4b8-4de5-9bc0-ad3e7064cbd0'))
    expect(a).not.toEqual(memoBars('51890123-9e02-4aaf-a3f2-0de42d3b394b'))
    expect(a).toHaveLength(28)
    expect(a.every((h) => h >= 0.25 && h <= 1)).toBe(true)
  })
})
