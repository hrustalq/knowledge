import { describe, expect, it, vi } from 'vitest'

vi.mock('./index', () => ({ refusal: () => null }))
const { isChunkError, likelyRoutes } = await import('./navigation')

describe('likelyRoutes', () => {
  const all = () => true

  it('ranks by visit count, then tops up from the seed without repeats', () => {
    const visits = ['/memos', '/merge-requests', '/memos', '/documents/:id', '/memos', '/merge-requests']
    expect(likelyRoutes(visits, ['/documents/:id', '/documents', '/qa'], all, 4)).toEqual([
      '/memos',
      '/merge-requests',
      '/documents/:id',
      '/documents',
    ])
  })

  it('is the seed alone for a new browser, minus what may not be opened', () => {
    expect(likelyRoutes([], ['/documents/:id', '/analytics', '/qa'], (p) => p !== '/analytics', 5)).toEqual([
      '/documents/:id',
      '/qa',
    ])
  })
})

describe('isChunkError', () => {
  it('knows a chunk that will not load from any other failure', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))).toBe(true)
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
    expect(isChunkError(new Error('boom'))).toBe(false)
  })
})
