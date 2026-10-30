import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/client')>()),
  api: { get: (...args: unknown[]) => apiFetch(...args) },
}))

const { documentContentQuery, documentDetailQuery, prefetchDocument } = await import('./page-queries')

describe('page queries (#628)', () => {
  it('fills the keys the page reads, and a refusal stays the click’s to report', async () => {
    const queryClient = new QueryClient()
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/v1/documents/{id}') return { document: { documentId: 'a' } }
      throw new Error('403')
    })
    await expect(prefetchDocument(queryClient, 'a')).resolves.toBeDefined()
    expect(queryClient.getQueryData(documentDetailQuery('a').queryKey)).toEqual({ document: { documentId: 'a' } })
    expect(queryClient.getQueryState(documentContentQuery('a', null).queryKey)?.status).toBe('error')
  })

  it('never shares an entry between the head, a revision and an as-of view', () => {
    const keys = [null, { revision: 'r1' }, { asOf: 'tag:v1' }].map((at) =>
      JSON.stringify(documentContentQuery('a', at).queryKey),
    )
    expect(new Set(keys).size).toBe(3)
  })
})
