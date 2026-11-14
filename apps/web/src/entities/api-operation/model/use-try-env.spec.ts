import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '@/shared/utils/memory-storage.testing'
import { forgetSignedInStorage } from '@/shared/utils/signed-in-storage'
import { useTryEnv } from './use-try-env'

// #1142: sign-out forgets the try-it credentials held in memory too, so the
// next person in the same tab does not find them on the same spec page.
beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemoryStorage())
  // The console runs client-side only; the server gets a throwaway env.
  vi.stubEnv('SSR', false)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('useTryEnv', () => {
  it('shares one env per spec page until sign-out, then starts blank', () => {
    const env = useTryEnv('doc1')
    env.token = 'secret'
    expect(useTryEnv('doc1').token).toBe('secret')

    forgetSignedInStorage()

    expect(useTryEnv('doc1').token).toBe('')
  })
})
