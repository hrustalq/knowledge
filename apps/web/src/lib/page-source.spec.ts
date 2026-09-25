import { describe, expect, it } from 'vitest'
import { EMPTY_PAGE, buildSource, readFrontmatter, samePage, type PageFields } from './page-source'

const page = (overrides: Partial<PageFields> = {}): PageFields => ({ ...EMPTY_PAGE, ...overrides })

describe('buildSource', () => {
  it('returns the body alone when there is no frontmatter to write', () => {
    expect(buildSource(page({ body: '# Hi' }))).toBe('# Hi')
  })

  it('re-emits frontmatter keys the editor does not model', () => {
    const source = buildSource(page({ body: 'text' }), { source: { system: 'jira' }, glossary: false })
    expect(source).toBe('---\nsource: {"system":"jira"}\nglossary: false\n---\ntext')
  })

  it('writes relations and tags, skipping blank rows', () => {
    const source = buildSource(
      page({
        body: 'b',
        relations: [
          { type: 'DEPENDS_ON', key: 'service:billing', name: '' },
          { type: 'DEPENDS_ON', key: '  ', name: 'blank' },
        ],
        tags: 'a, b,',
      }),
    )
    expect(source).toContain('  - type: DEPENDS_ON')
    expect(source).toContain('target: { type: "service", key: "service:billing", name: "billing" }')
    expect(source).toContain('tags: ["a", "b"]')
    expect(source).not.toContain('blank')
  })
})

describe('readFrontmatter', () => {
  it('splits modelled keys from the ones carried verbatim', () => {
    const fm = readFrontmatter({
      relations: [
        { type: 'OWNS', target: 'team:core' },
        { type: 'USES', target: { key: 'service:auth', name: 'Auth' } },
        { type: '', target: 'dropped' },
      ],
      tags: ['x', 'y'],
      source: 'confluence',
    })
    expect(fm.relations).toEqual([
      { type: 'OWNS', key: 'team:core', name: '' },
      { type: 'USES', key: 'service:auth', name: 'Auth' },
    ])
    expect(fm.tags).toBe('x, y')
    expect(fm.other).toEqual({ source: 'confluence' })
  })

  it('round-trips through buildSource', () => {
    const fm = readFrontmatter({ tags: ['x'], relations: [{ type: 'OWNS', target: { key: 'team:core', name: 'core' } }] })
    const again = readFrontmatter({ tags: ['x'], relations: [{ type: 'OWNS', target: { key: 'team:core', name: 'core' } }] })
    expect(buildSource(page({ ...fm }), fm.other)).toBe(buildSource(page({ ...again }), again.other))
  })
})

describe('samePage', () => {
  it('ignores what publishing would normalise away', () => {
    const base = page({ title: 'T', tags: 'a, b' })
    expect(samePage(page({ title: 'T ', tags: 'a,b,' }), base)).toBe(true)
    expect(samePage(page({ title: 'T', tags: 'a, b', relations: [{ type: 'X', key: '', name: '' }] }), base)).toBe(true)
  })

  it('does not count the revision message as a change', () => {
    expect(samePage(page({ message: 'why' }), page())).toBe(true)
  })

  it('sees changes to the body, placement and relations', () => {
    expect(samePage(page({ body: 'a' }), page({ body: 'b' }))).toBe(false)
    expect(samePage(page({ parentId: 'p' }), page())).toBe(false)
    expect(samePage(page({ relations: [{ type: 'OWNS', key: 'team:x', name: '' }] }), page())).toBe(false)
  })
})
