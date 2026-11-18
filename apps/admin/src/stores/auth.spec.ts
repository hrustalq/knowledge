import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiRequestError } from '@knowledge/api-client'
import { useAuthStore } from './auth'

const fetchApi = vi.fn()
vi.mock('@/shared/api/queries', async () => ({
  fetchApi: (...a: unknown[]) => fetchApi(...a),
  isApiRequestError: (await import('@knowledge/api-client')).isApiRequestError,
}))

const me = (over: object) => ({ isAdmin: false, mode: 'session', locale: 'en', ...over })
const refusal = (statusCode: number) =>
  new ApiRequestError({ statusCode, code: 'UNAUTHENTICATED', message: '', path: '', requestId: '', timestamp: '' })

describe('auth store', () => {
  beforeEach(() => {
    const pinia = createPinia()
    pinia.use(() => ({ queryClient: {} as never }))
    setActivePinia(pinia)
    fetchApi.mockReset()
  })

  it('opens the console to a platform admin and the dev principal only', async () => {
    for (const [who, may] of [
      [me({ isAdmin: true }), true],
      [me({ mode: 'dev' }), true],
      // A workspace admin is not a platform admin: memberships do not count.
      [me({ memberships: [{ role: 'admin' }] }), false],
    ] as const) {
      setActivePinia(createPinia().use(() => ({ queryClient: {} as never })))
      fetchApi.mockResolvedValueOnce(who)
      const auth = useAuthStore()
      await auth.ensureLoaded()
      expect(auth.canUseConsole).toBe(may)
    }
  })

  it('tells a signed-out visitor from a failed check, and asks again after a failure', async () => {
    const auth = useAuthStore()
    fetchApi.mockRejectedValueOnce(new Error('network'))
    await auth.ensureLoaded()
    expect([auth.loaded, auth.error]).toEqual([false, expect.any(Error)])
    fetchApi.mockRejectedValueOnce(refusal(401))
    await auth.ensureLoaded()
    expect([auth.loaded, auth.me, auth.error]).toEqual([true, null, null])
    expect(fetchApi).toHaveBeenCalledTimes(2)
  })
})
