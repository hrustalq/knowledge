import { AGENT_OUTCOMES, type AgentOutcome, type AgentOutcomeGroup } from '@knowledge/contracts'

/**
 * How one outcome count is shown (#305). Below `minRuns` runs (or votes) it is
 * the raw count over the total — "4 of 9" — never a percentage: a rate over
 * nine is a guess dressed as a measurement. At or above it, a ratio.
 */
export type OutcomeShare = { kind: 'raw'; count: number; total: number } | { kind: 'rate'; ratio: number; count: number; total: number }

export function totalOf(group: AgentOutcomeGroup): number {
  return AGENT_OUTCOMES.reduce((sum, o) => sum + group.counts[o], 0)
}

export function outcomeShare(group: AgentOutcomeGroup, outcome: AgentOutcome, minRuns: number): OutcomeShare {
  const count = group.counts[outcome]
  const total = totalOf(group)
  if (group.runs < minRuns || total === 0) return { kind: 'raw', count, total }
  return { kind: 'rate', ratio: count / total, count, total }
}

/** The outcomes a source can produce: a finding is never downvoted, an answer never dismissed. */
export function outcomesFor(source: AgentOutcomeGroup['source']): readonly AgentOutcome[] {
  return AGENT_OUTCOMES.filter((o) => (source === 'finding' ? o !== 'downvoted' : o !== 'dismissed'))
}

/** A prompt hash is 64 hex characters; eight tell two prompts apart on a screen. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}
