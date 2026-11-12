/**
 * A model-led interview's answers (#731, #934), the pure half: what one
 * round's controls send, and how a sent answer reads back into the controls.
 * The server rebuilds an interview from the rounds it is sent; this is the
 * only place the web turns controls into those rounds.
 */
import type { AssistantPromptField, InterviewAnswer, InterviewRound } from '@knowledge/contracts'
import { blankValues, type PromptValues } from './prompt-values'

/** One question's answer as the API reads it: typed words replace a choice and join a checklist's ticks. */
export function answerOf(value: string | string[] | undefined, other: string): InterviewAnswer {
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
export function seedOf(round: InterviewRound): { values: PromptValues; others: Record<string, string> } {
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
export function answerText(q: AssistantPromptField, a: InterviewAnswer | undefined, skipped: string): string {
  if (a == null || a === '' || (Array.isArray(a) && !a.length)) return skipped
  const label = (v: string) => (q.type === 'text' ? v : (q.options.find((o) => o.value === v)?.label ?? v))
  return (Array.isArray(a) ? a : [a]).map(label).join(', ')
}
