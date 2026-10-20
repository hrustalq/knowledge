import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch,
}))

const { useProjectsStore } = await import('./projects')
const { useWorkspacesStore } = await import('./workspaces')

const project = (projectId: string) => ({ projectId, name: projectId })

/** A response the test releases by hand, so calls can overlap the way mounts do. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActivePinia(createPinia())
  apiFetch.mockReset()
})

describe('roster fetches share one request while in flight (#279)', () => {
  it('projects: the rail, the breadcrumbs and the page asking in one tick make one request', async () => {
    const res = deferred<{ projects: ReturnType<typeof project>[] }>()
    apiFetch.mockReturnValue(res.promise)
    const store = useProjectsStore()

    const calls = [store.fetchList(), store.fetchList(), store.fetchList()]
    expect(apiFetch).toHaveBeenCalledTimes(1)

    res.resolve({ projects: [project('p-1')] })
    await Promise.all(calls)
    expect(store.loaded).toBe(true)
    expect(store.items.map((p) => p.projectId)).toEqual(['p-1'])
  })

  it('projects: a call after the answer landed asks again (a refresh is still a refresh)', async () => {
    apiFetch.mockResolvedValue({ projects: [project('p-1')] })
    const store = useProjectsStore()
    await store.fetchList()
    await store.fetchList()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('projects: a failed request is shared too, and does not stick', async () => {
    const res = deferred<never>()
    apiFetch.mockReturnValueOnce(res.promise)
    const store = useProjectsStore()
    const a = store.fetchList()
    const b = store.fetchList()
    res.reject(new Error('403'))
    await expect(a).rejects.toThrow('403')
    await expect(b).rejects.toThrow('403')
    expect(apiFetch).toHaveBeenCalledTimes(1)

    apiFetch.mockResolvedValueOnce({ projects: [] })
    await store.fetchList()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(store.loaded).toBe(true)
  })

  it('projects: still one request when each call runs on its own Proxy of the store (dev devtools)', async () => {
    const res = deferred<{ projects: ReturnType<typeof project>[] }>()
    apiFetch.mockReturnValue(res.promise)
    const store = useProjectsStore()
    // Pinia's devtools plugin applies every options-store action to a fresh Proxy.
    const a = store.fetchList.call(new Proxy(store, {}))
    const b = store.fetchList.call(new Proxy(store, {}))
    expect(apiFetch).toHaveBeenCalledTimes(1)
    res.resolve({ projects: [] })
    await Promise.all([a, b])
  })

  it('projects: two app instances (two SSR renders) never share a request', async () => {
    apiFetch.mockResolvedValue({ projects: [] })
    const first = useProjectsStore(createPinia())
    const second = useProjectsStore(createPinia())
    await Promise.all([first.fetchList(), second.fetchList()])
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('workspaces: the switcher and the search widget asking together make one request', async () => {
    const res = deferred<{ workspaces: { workspaceId: string; name: string }[] }>()
    apiFetch.mockReturnValue(res.promise)
    const store = useWorkspacesStore()

    store.ensureLoaded()
    store.ensureLoaded()
    const direct = store.fetchList()
    expect(apiFetch).toHaveBeenCalledTimes(1)

    res.resolve({ workspaces: [{ workspaceId: 'w-1', name: 'One' }] })
    await direct
    expect(store.loaded).toBe(true)
    expect(store.items).toHaveLength(1)
  })
})
