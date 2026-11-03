import { describe, expect, it } from 'vitest'
import type { GlossaryTerm } from '@knowledge/contracts'
import { pageTerms } from './glossary'

// The page being read picks the vocabulary, never the project switcher (#702).
// The roster is the whole workspace's, so a page in project B must drop a term
// only project A defines, and a page with no known project links nothing.

const term = (termId: string, projectId: string, extra: Partial<GlossaryTerm> = {}) =>
  ({ termId, projectId, term: termId, aliases: [], enabled: true, documentId: null, ...extra }) as GlossaryTerm

const roster = [term('order', 'A'), term('invoice', 'B'), term('retired', 'B', { enabled: false })]
const ids = (terms: GlossaryTerm[]) => terms.map((t) => t.termId)

describe('pageTerms', () => {
  it("keeps only the page's own project's enabled terms", () => {
    expect(ids(pageTerms(roster, { projectId: 'B', documentId: 'p1' }))).toEqual(['invoice'])
  })

  it('links nothing when the page has no resolved project', () => {
    expect(pageTerms(roster, { projectId: null, documentId: 'p1' })).toEqual([])
  })

  it('drops a term the page itself defines', () => {
    const defining = [term('invoice', 'B', { documentId: 'p1' })]
    expect(pageTerms(defining, { projectId: 'B', documentId: 'p1' })).toEqual([])
  })
})
