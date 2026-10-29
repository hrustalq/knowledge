import { describe, expect, it } from 'vitest'
import type { AgentOutcomeGroup } from '@knowledge/contracts'
import { outcomeShare, outcomesFor, shortHash, totalOf } from './agent-outcomes-ui'

const group = (runs: number, counts: Partial<AgentOutcomeGroup['counts']> = {}): AgentOutcomeGroup => ({
  source: 'finding',
  agentKey: 'reviewer',
  promptHash: null,
  model: null,
  runs,
  counts: { accepted: 0, dismissed: 0, downvoted: 0, pending: 0, ...counts },
})

describe('outcomeShare', () => {
  it('shows raw counts below the run threshold, however many findings', () => {
    const g = group(19, { dismissed: 4, accepted: 5 })
    expect(outcomeShare(g, 'dismissed', 20)).toEqual({ kind: 'raw', count: 4, total: 9 })
  })

  it('shows a rate from the threshold on', () => {
    const g = group(20, { dismissed: 1, accepted: 3 })
    expect(outcomeShare(g, 'dismissed', 20)).toEqual({ kind: 'rate', ratio: 0.25, count: 1, total: 4 })
  })

  it('never divides by zero', () => {
    expect(outcomeShare(group(40), 'accepted', 20)).toEqual({ kind: 'raw', count: 0, total: 0 })
  })
})

describe('helpers', () => {
  it('totals every outcome', () => {
    expect(totalOf(group(1, { accepted: 1, pending: 2 }))).toBe(3)
  })
  it('offers only the outcomes a source can produce', () => {
    expect(outcomesFor('finding')).toEqual(['accepted', 'dismissed', 'pending'])
    expect(outcomesFor('answer')).toEqual(['accepted', 'downvoted', 'pending'])
  })
  it('shortens a prompt hash', () => {
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa')
  })
})
