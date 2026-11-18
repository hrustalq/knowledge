import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, markRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { QueryClient } from '@tanstack/vue-query'

// #1297: a tab follows its person's role, capabilities and membership live.
const post = vi.hoisted(() => vi.fn(async () => ({ ticket: 'kt_x' })))
vi.mock('@/shared/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/queries')>()),
  api: { post },
}))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { useEventsStore } = await import('./events')
const { useAuthStore } = await import('./auth')
const { usePermissionsStore } = await import('./permissions')
const { setActiveWorkspace } = await import('@/shared/api/api')

class FakeSource {
  static all: FakeSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSource.all.push(this)
  }
  close() {}
}

const WS = '11111111-1111-4111-8111-111111111111'
const t = ((k: string) => k) as never

beforeEach(() => {
  FakeSource.all = []
  // Vitest runs this in Node, where the store would take itself for SSR and never connect.
  vi.stubEnv('SSR', false)
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', FakeSource)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('location', { assign: vi.fn() })
  vi.stubGlobal('window', { location })
  const pinia = createPinia()
  pinia.use(() => ({ queryClient: markRaw(new QueryClient()) }))
  createApp({}).use(pinia)
  setActivePinia(pinia)
  setActiveWorkspace(WS)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function connected() {
  const events = useEventsStore()
  const reload = vi.spyOn(useAuthStore(), 'reload').mockResolvedValue()
  const refresh = vi.spyOn(usePermissionsStore(), 'refresh').mockResolvedValue()
  events.connect(t)
  await vi.waitFor(() => expect(FakeSource.all).toHaveLength(1))
  return { reload, refresh, source: FakeSource.all[0]! }
}

describe('events: standing', () => {
  it('permissions.changed re-reads /v1/me, then the grants', async () => {
    const { reload, refresh, source } = await connected()
    source.onmessage!({ data: JSON.stringify({ type: 'permissions.changed', workspaceId: WS, userId: 'u1', at: '' }) })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(reload).toHaveBeenCalledOnce()
    expect(location.assign).not.toHaveBeenCalled()
  })

  it('a dropped stream re-reads both before it reopens', async () => {
    const { reload, refresh, source } = await connected()
    source.onerror!()
    expect(reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(2))
    expect(reload).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(reload.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder.at(-1)!)
  })

  it('losing the active workspace starts the app over at home', async () => {
    const { reload, refresh, source } = await connected()
    reload.mockImplementation(async () => setActiveWorkspace('22222222-2222-4222-8222-222222222222'))
    source.onmessage!({ data: JSON.stringify({ type: 'permissions.changed', workspaceId: WS, userId: 'u1', at: '' }) })
    await vi.waitFor(() => expect(location.assign).toHaveBeenCalledWith('/'))
    expect(refresh).not.toHaveBeenCalled()
  })
})
