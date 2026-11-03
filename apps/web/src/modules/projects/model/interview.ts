/**
 * Describe it's interview (#731), the pure half of the panel: what one round's
 * controls send as answers, how a sent answer reads back into the controls,
 * and how the terms the scaffolder read off the answers reach Conventions.
 * The server rebuilds the interview from the rounds it is sent; this is the
 * only place the web turns controls into those rounds.
 */
import type {
  AssistantPromptField,
  Blueprint,
  BlueprintGlossaryTerm,
  BlueprintInterviewAnswer,
  BlueprintInterviewRound,
  BlueprintNode,
} from '@knowledge/contracts'
import { blankValues, type PromptValues } from '@/entities/assistant'

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

/** One question's answer as the API reads it: typed words replace a choice and join a checklist's ticks. */
export function answerOf(value: string | string[] | undefined, other: string): BlueprintInterviewAnswer {
  const extra = other.trim()
  if (Array.isArray(value)) {
    const all = [...value, ...(extra ? [extra] : [])]
    return all.length ? all : null
  }
  return extra || String(value ?? '').trim() || null
}

export function answersOf(questions: AssistantPromptField[], values: PromptValues, others: Record<string, string>) {
  return Object.fromEntries(questions.map((q) => [q.name, answerOf(values[q.name], others[q.name] ?? '')]))
}

/** A round can be sent once every choice has an answer; a checklist or text left empty is skipped. */
export const roundComplete = (questions: AssistantPromptField[], values: PromptValues, others: Record<string, string>) =>
  questions.every((q) => q.type !== 'choice' || answerOf(values[q.name], others[q.name] ?? '') !== null)

/** A round's controls: its sent answers read back (offered values ticked, the rest as typed words), else the suggestions. */
export function seedOf(round: BlueprintInterviewRound): { values: PromptValues; others: Record<string, string> } {
  if (!round.answers) return { values: blankValues(round.questions), others: {} }
  const values = blankValues(round.questions, false)
  const others: Record<string, string> = {}
  for (const q of round.questions) {
    const a = round.answers[q.name]
    if (a == null) continue
    if (q.type === 'text') {
      values[q.name] = String(a)
      continue
    }
    const offered = (v: string) => q.options.some((o) => o.value === v)
    const picked = Array.isArray(a) ? a : [a]
    values[q.name] = q.type === 'checklist' ? picked.filter(offered) : (picked.find(offered) ?? '')
    others[q.name] = picked.filter((v) => !offered(v)).join(', ')
  }
  return { values, others }
}

/** An answer as one readable line: option labels, the person's own words as written, null as `skipped`. */
export function answerText(q: AssistantPromptField, a: BlueprintInterviewAnswer | undefined, skipped: string): string {
  if (a == null || a === '' || (Array.isArray(a) && !a.length)) return skipped
  const label = (v: string) => (q.type === 'text' ? v : (q.options.find((o) => o.value === v)?.label ?? v))
  return (Array.isArray(a) ? a : [a]).map(label).join(', ')
}

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
