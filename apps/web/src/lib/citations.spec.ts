import { describe, expect, it } from 'vitest'
import type { AssistantSource } from '@knowledge/contracts'
import { CITE_MARKER_RE, citeLabels, citeNumber, headingAnchor, sourceByCite, sourceHref, verificationTone } from './citations'

/**
 * The read side of sentence citations (docs/features/38). `decorateCitations`
 * needs a DOM and is exercised in the browser; what is pinned here is the
 * grammar it shares with the API and where a marker sends the reader.
 */
describe('citation markers', () => {
  it('reads every form the API normalizes to, and the looser ones a stream delivers', () => {
    const text = 'One. [S1] Two [S2, S3]. Three[ s4 ;S5 ]. Not [X1] nor [1].'
    const found = [...text.matchAll(CITE_MARKER_RE)].map((m) => citeLabels(m[0]))
    expect(found).toEqual([['S1'], ['S2', 'S3'], ['S4', 'S5']])
  })

  it('shows the reader the number, not the letter', () => {
    expect(citeNumber('S12')).toBe(12)
    expect(citeNumber('s3')).toBe(3)
    expect(citeNumber('nope')).toBe(0)
  })
})

describe('where a citation opens', () => {
  const sources: AssistantSource[] = [
    { documentId: 'doc-1', title: 'Auth', cite: 'S1', headingPath: ['Auth', 'Session expiry'] },
    { documentId: 'doc-2', title: 'Keys', cite: 'S2' },
    { kind: 'web', url: 'https://x.test/p', site: 'x.test', title: 'X', cite: 'S3' },
  ]

  it('links to the cited section when one is known, else the page', () => {
    expect(headingAnchor(['Auth', 'Session expiry'])).toBe('session-expiry')
    expect(headingAnchor([])).toBe('')
    expect(sourceHref(sources[0] as never)).toBe('/documents/doc-1#session-expiry')
    expect(sourceHref(sources[1] as never)).toBe('/documents/doc-2')
  })

  it('finds a source by its label', () => {
    expect(sourceByCite(sources, 'S3')).toBe(sources[2])
    expect(sourceByCite(sources, 'S9')).toBeUndefined()
  })
})

describe('verificationTone', () => {
  it('maps the four states and the absent one', () => {
    expect(verificationTone('verified')).toBe('ok')
    expect(verificationTone('outdated')).toBe('warn')
    expect(verificationTone('flagged')).toBe('bad')
    expect(verificationTone('unverified')).toBe('none')
    expect(verificationTone(undefined)).toBe('none')
  })
})
