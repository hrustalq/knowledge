import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * The opening move never overrides the person (#931): `/assistant` resumes the
 * latest thread only if nothing was chosen while the roster loaded.
 */
const fetchApi = vi.fn()
vi.mock('@/shared/api/queries', () => ({ fetchApi: (...a: unknown[]) => fetchApi(...a), api: {} }))
vi.mock('@/shared/api/api', () => ({ getWorkspaceId: () => 'ws' }))

const { useAssistantStore } = await import('./assistant.store')

const old = { id: 't-old', documentId: null }

function roster() {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  fetchApi.mockImplementation(async (_qc: unknown, path: string) => {
    if (path === '/v1/assistant/threads') {
      await gate
      return { threads: [old], nextCursor: null }
    }
    return { thread: old, messages: [] }
  })
  return release
}

describe('assistant.openLatest', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fetchApi.mockReset()
  })

  it('resumes the latest thread when nothing was pressed', async () => {
    const release = roster()
    const store = useAssistantStore()
    const opening = store.openLatest()
    expect(store.resuming).toBe(true)
    release()
    await opening
    expect(store.activeThread?.id).toBe('t-old')
    expect(store.resuming).toBe(false)
  })

  it('stands down when a new chat was started while the roster loaded', async () => {
    const release = roster()
    const store = useAssistantStore()
    const opening = store.openLatest()
    store.startBlank()
    release()
    await opening
    expect(store.activeThread).toBeNull()
    expect(store.threads).toHaveLength(1)
  })
})
