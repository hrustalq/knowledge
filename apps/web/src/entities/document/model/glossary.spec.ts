import { describe, expect, it } from 'vitest'
import type { GlossaryTerm } from '@knowledge/contracts'
import { TERM_MATCH_CASES } from '@knowledge/contracts/content/term-cases'
import { buildMatcher, candidateFor, pageTerms, spellingMatches } from './glossary'

// The page being read picks the vocabulary, never the project switcher (#702).
// The roster is the whole workspace's, so a page in project B must drop a term
// only project A defines, and a page with no known project links nothing.

const term = (termId: string, projectId: string | null, extra: Partial<GlossaryTerm> = {}) =>
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

  // #926: a workspace term links everywhere, unless the page's project defines the word itself.
  it("adds the workspace's terms, and lets the project's own entry replace one of the same name", () => {
    const shared = [term('sla', null), term('tenant', null), term('tenant-b', 'B', { term: 'Tenant' }), ...roster]
    expect(ids(pageTerms(shared, { projectId: 'A', documentId: 'p1' }))).toEqual(['order', 'sla', 'tenant'])
    expect(ids(pageTerms(shared, { projectId: 'B', documentId: 'p1' }))).toEqual(['tenant-b', 'invoice', 'sla'])
  })

  it("keeps a workspace term replaced even when the project's entry is retired", () => {
    const shared = [term('tenant', null), term('tenant-b', 'B', { term: 'tenant', enabled: false })]
    expect(pageTerms(shared, { projectId: 'B', documentId: 'p1' })).toEqual([])
  })
})

// #1210: the same table the API's matchers run (apps/api/test/term-pattern.spec.ts).
describe('buildMatcher', () => {
  it.each(TERM_MATCH_CASES)('$term in "$text"', (c) => {
    const matcher = buildMatcher([term('t', 'A', { term: c.term, caseSensitive: !!c.caseSensitive, matchAliases: true })])!
    const match = matcher.re!.exec(c.text)
    const candidate = match ? candidateFor(matcher, match) : undefined
    const linked = match && candidate && spellingMatches(candidate, match[0]) ? match[0] : null
    expect(linked).toBe(c.match)
  })

  it('claims an inflected form for the spelling that matched, longest first', () => {
    const matcher = buildMatcher([
      term('freeze', 'A', { term: 'заморозка' }),
      term('release-freeze', 'A', { term: 'заморозка выкладок' }),
      term('vega', 'A', { term: 'Vega', aliases: ['Вега'], matchAliases: true }),
    ])!
    const linked = [...'перед заморозкой выкладок у Веги'.matchAll(matcher.re!)].map((m) => [m[0], candidateFor(matcher, m)?.term.termId])
    expect(linked).toEqual([
      ['заморозкой выкладок', 'release-freeze'],
      ['Веги', 'vega'],
    ])
  })
})
