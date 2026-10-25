// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPwaCaches } from './pwa'

describe('clearPwaCaches (#472)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('deletes every cache and unregisters the worker, so nothing of the session stays on the device', async () => {
    const store = new Map([['workbox-precache-v2-x', {}], ['other', {}]])
    vi.stubGlobal('caches', {
      keys: async () => [...store.keys()],
      delete: async (key: string) => store.delete(key),
    })
    const unregister = vi.fn(async () => true)
    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [{ unregister }] } })

    await clearPwaCaches()

    expect(store.size).toBe(0)
    expect(unregister).toHaveBeenCalledOnce()
  })
})
