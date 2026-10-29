import { describe, expect, it } from 'vitest'
import type { AssistantSource } from '@knowledge/contracts'
import {
  CITE_MARKER_RE,
  citeLabels,
  citeNumber,
  headingAnchor,
  sourceByCite,
  sourceHref,
  unsupportedMarkers,
  verificationTone,
} from './citations'

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
  it('maps every state and the absent one', () => {
    expect(verificationTone('verified')).toBe('ok')
    expect(verificationTone('edited')).toBe('warn')
    expect(verificationTone('expired')).toBe('warn')
    expect(verificationTone('requested')).toBe('warn')
    expect(verificationTone('outdated')).toBe('bad')
    expect(verificationTone('flagged')).toBe('bad')
    expect(verificationTone('unverified')).toBe('none')
    expect(verificationTone(undefined)).toBe('none')
  })
})

describe('unsupportedMarkers (#530)', () => {
  // Offsets as the API stores them: a sentence span ends after its markers.
  const text = 'Deploys run on Tuesdays. [S1] Use `arr[S2]` here. [S2]\n\n```\nx = y[S3]\n```\n\nThe bot is Hermes. [S3]'
  const span = (sentence: string) => {
    const start = text.indexOf(sentence)
    return { start, end: start + sentence.length }
  }

  it('counts markers in drawing order, skipping code, and picks those closing an unsupported sentence', () => {
    const citations = [
      { ...span('Deploys run on Tuesdays. [S1]'), cites: ['S1'], support: 'supported' as const },
      { ...span('Use `arr[S2]` here. [S2]'), cites: ['S2'] },
      { ...span('The bot is Hermes. [S3]'), cites: ['S3'], support: 'unsupported' as const },
    ]
    // Markers drawn: [S1] = 0, [S2] = 1, [S3] = 2; the two inside code are not.
    expect([...unsupportedMarkers(text, citations)]).toEqual([2])
  })

  it('is empty with no marks', () => {
    expect(unsupportedMarkers(text, undefined).size).toBe(0)
  })
})
