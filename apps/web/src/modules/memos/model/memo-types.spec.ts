import { describe, expect, it } from 'vitest'
import { newMemoTypeKey } from './memo-types'

describe('newMemoTypeKey', () => {
  it('uses the Latin slug of the name when it is free', () => {
    expect(newMemoTypeKey('  Hiring sync ', ['daily', 'retro'])).toBe('hiring-sync')
  })

  it('gives a name in another script the first free numbered key', () => {
    expect(newMemoTypeKey('Созвон по найму', ['daily'])).toBe('type-1')
    expect(newMemoTypeKey('Созвон по найму', ['daily', 'type-1'])).toBe('type-2')
  })

  it('never returns a key another type has, nor one the API would refuse', () => {
    expect(newMemoTypeKey('Retro', ['daily', 'retro'])).toBe('type-1')
    expect(newMemoTypeKey('1:1', [])).toBe('type-1')
  })
})
