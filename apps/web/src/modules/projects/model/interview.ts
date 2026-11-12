/**
 * Describe it's interview (#731), the pure half of the panel: what one round's
 * controls send as answers, how a sent answer reads back into the controls,
 * and how the terms the scaffolder read off the answers reach Conventions.
 * The server rebuilds the interview from the rounds it is sent; this is the
 * only place the web turns controls into those rounds.
 */
import type { Blueprint, BlueprintGlossaryTerm, BlueprintInterviewRound, BlueprintNode } from '@knowledge/contracts'

// What a round's controls send and read back is every interview's (#934): it lives with the controls.
export { answersOf, answerText, roundComplete, seedOf } from '@/entities/assistant'

export interface DescribeInterview {
  brief: string
  /** The listed blueprint the interview adapts, or '' for none. */
  startKey: string
  /** Every round asked; the last one without `answers` is the open one. */
  rounds: BlueprintInterviewRound[]
  /** The outline and candidate terms from the last asking reply. */
  outline: BlueprintNode[]
  terms: BlueprintGlossaryTerm[]
  /** A draft came back from these rounds and went to Shape. */
  drafted: boolean
}

export const freshInterview = (brief = ''): DescribeInterview => ({
  brief,
  startKey: '',
  rounds: [],
  outline: [],
  terms: [],
  drafted: false,
})

/** The draft's glossary terms added to its conventions, so Conventions shows them ticked; a term already there wins. */
export function withTerms(blueprint: Blueprint, terms: BlueprintGlossaryTerm[]): Blueprint {
  const glossary = [...(blueprint.conventions?.glossary ?? [])]
  const seen = new Set(glossary.map((g) => g.term.trim().toLowerCase()))
  for (const term of terms) {
    const key = term.term.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    glossary.push(term)
  }
  return glossary.length ? { ...blueprint, conventions: { ...blueprint.conventions, glossary } } : blueprint
}
