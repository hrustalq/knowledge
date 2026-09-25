import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PAGE } from './page-source'
import {
  hasWorkingCopy,
  readWorkingCopy,
  removeWorkingCopy,
  workingCopyKey,
  writeWorkingCopy,
  type WorkingCopy,
} from './working-copy'

class MemoryStorage {
  map = new Map<string, string>()
  full = false
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.full) throw new DOMException('quota', 'QuotaExceededError')
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('window', { localStorage: storage })
})
afterEach(() => vi.unstubAllGlobals())

const copy = (overrides: Partial<WorkingCopy> = {}): WorkingCopy => ({
  v: 1,
  ...EMPTY_PAGE,
  title: 'Draft',
  body: 'text',
  documentId: 'doc',
  baseRevisionId: 'rev',
  savedAt: 1,
  ...overrides,
})

describe('working copy storage', () => {
  it('keys per workspace and page, with one slot for the page not created yet', () => {
    expect(workingCopyKey('ws', 'doc')).toBe('kn:unstaged:v1:ws:doc')
    expect(workingCopyKey('ws', null)).toBe('kn:unstaged:v1:ws:new')
  })

  it('writes, reads back and removes', () => {
    const key = workingCopyKey('ws', 'doc')
    expect(writeWorkingCopy(key, copy())).toBe(true)
    expect(readWorkingCopy(key)).toEqual(copy())
    expect(hasWorkingCopy('ws', 'doc')).toBe(true)
    removeWorkingCopy(key)
    expect(readWorkingCopy(key)).toBeNull()
  })

  it('reports a refused write instead of claiming the edits are safe', () => {
    storage.full = true
    expect(writeWorkingCopy(workingCopyKey('ws', 'doc'), copy())).toBe(false)
  })

  it('refuses to restore a shape it does not recognise', () => {
    storage.setItem('k', JSON.stringify({ v: 2, title: 'x' }))
    storage.setItem('broken', '{not json')
    expect(readWorkingCopy('k')).toBeNull()
    expect(readWorkingCopy('broken')).toBeNull()
  })

  it('does nothing without storage (SSR, blocked site data)', () => {
    vi.stubGlobal('window', undefined)
    expect(writeWorkingCopy('k', copy())).toBe(false)
    expect(readWorkingCopy('k')).toBeNull()
    expect(() => removeWorkingCopy('k')).not.toThrow()
  })
})
