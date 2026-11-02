import { describe, expect, it, vi } from 'vitest'

const pages: Record<string, { childTemplateRef: string | null; childTitlePattern: string | null; children: string[] }> = {
  decisions: { childTemplateRef: 'builtin:adr', childTitlePattern: 'ADR {{n:4}}: ', children: [] },
  plain: { childTemplateRef: null, childTitlePattern: null, children: ['Anything'] },
}
const fetchApi = vi.fn(async (_qc: unknown, url: string, opts: { path?: { id: string }; query?: { parentId: string } }) =>
  url === '/v1/documents/tree'
    ? { roots: pages[opts.query!.parentId]!.children.map((title) => ({ title })) }
    : { document: pages[opts.path!.id] },
)
vi.mock('@/shared/api/queries', () => ({ fetchApi }))
vi.mock('@/shared/api/api', () => ({ getWorkspaceId: () => 'ws' }))

const { nextInCollection } = await import('./collection')

describe('New page under a collection (#716)', () => {
  it('offers ADR 0001 with the ADR template, then ADR 0002', async () => {
    expect(await nextInCollection({} as never, 'decisions')).toEqual({ title: 'ADR 0001: ', templateRef: 'builtin:adr' })
    pages.decisions!.children.push('ADR 0001: Queue')
    expect((await nextInCollection({} as never, 'decisions'))?.title).toBe('ADR 0002: ')
  })

  it('counts archived children, so a number is never handed out twice', async () => {
    await nextInCollection({} as never, 'decisions')
    expect(fetchApi).toHaveBeenCalledWith(expect.anything(), '/v1/documents/tree', {
      query: expect.objectContaining({ parentId: 'decisions', includeArchived: '1' }),
    }, { fresh: true })
  })

  it('is null on an ordinary page, without listing its children', async () => {
    fetchApi.mockClear()
    expect(await nextInCollection({} as never, 'plain')).toBeNull()
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })
})
