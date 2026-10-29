import type { AssistantFlowAnswer, AssistantFormPrompt, AssistantMessageInfo, AssistantPromptField, FlowAnswer } from '@knowledge/contracts'

/** How one step of a question flow (#425) reads in the transcript. */
export interface FlowStep {
  /** The answer to this step's question, given right after it. */
  answer: AssistantFlowAnswer | null
  /**
   * Answered and then re-answered later in the run, or never answered because
   * the person changed an earlier step instead. Either way it no longer applies.
   */
  superseded: boolean
  /** The step answered just before the open question — the one "Change" re-answers. */
  changeable: boolean
}

type StepMessage = Pick<AssistantMessageInfo, 'id' | 'role' | 'prompt' | 'answer'>

function formOf(m: StepMessage | undefined): AssistantFormPrompt | null {
  return m?.role === 'assistant' && m.prompt?.kind === 'form' ? m.prompt : null
}

function flowOf(m: StepMessage | undefined) {
  const p = formOf(m)
  return p?.flow && p.questionId ? { flow: p.flow, questionId: p.questionId } : null
}

/** Whether the run of `flow` that continues after index `from` answers `questionId` again. */
function reansweredAfter(messages: StepMessage[], from: number, flow: string, questionId: string): boolean {
  for (let j = from + 1; j < messages.length; j++) {
    const later = messages[j]
    if (flowOf(later)?.flow === flow) continue
    if (later.role !== 'user' || later.answer?.flow !== flow) return false
    if (later.answer.questionId === questionId) return true
  }
  return false
}

/** A flow answer in words: option labels, not values. */
export function answerText(
  field: AssistantPromptField | undefined,
  value: FlowAnswer,
  words: { skipped: string; none: string },
): string {
  if (value === null) return words.skipped
  const label = (v: string) => (field && field.type !== 'text' ? field.options.find((o) => o.value === v)?.label : undefined) ?? v
  if (Array.isArray(value)) return value.length ? value.map(label).join(', ') : words.none
  return label(value)
}

/** A user turn that answered a flow step: the question it answered, and whether a later answer replaced it. */
export interface AnswerTurn {
  prompt: AssistantFormPrompt | null
  superseded: boolean
}

/** Every flow answer in a thread, keyed by its message id. */
export function answerTurns(messages: StepMessage[]): Map<string, AnswerTurn> {
  const turns = new Map<string, AnswerTurn>()
  messages.forEach((m, i) => {
    const a = m.role === 'user' ? m.answer : null
    if (!a) return
    // The question it answers — not always the message before it: "Change"
    // answers an earlier step while a newer question is open.
    let prompt: AssistantFormPrompt | null = null
    for (let j = i - 1; j >= 0 && !prompt; j--) {
      const p = formOf(messages[j])
      if (p?.flow === a.flow && p.questionId === a.questionId) prompt = p
    }
    turns.set(m.id, { prompt, superseded: reansweredAfter(messages, i, a.flow, a.questionId) })
  })
  return turns
}

/**
 * Every flow step in a thread, keyed by its message id. Read from the
 * messages alone, the way the API's `openFlow` rebuilds the run: a run is an
 * unbroken chain of one flow's prompts and the user answers carrying it, and
 * the API accepts an answer to the open question or the one answered last.
 */
export function flowSteps(messages: StepMessage[]): Map<string, FlowStep> {
  const steps = new Map<string, FlowStep>()
  const open = flowOf(messages.at(-1))
  messages.forEach((m, i) => {
    const step = flowOf(m)
    if (!step) return
    const next = messages[i + 1]
    const given = next?.role === 'user' && next.answer?.flow === step.flow ? next.answer : null
    const answer = given?.questionId === step.questionId ? given : null
    const reanswered = answer !== null && reansweredAfter(messages, i + 1, step.flow, step.questionId)

    steps.set(m.id, {
      answer,
      superseded: given !== null && (answer === null || reanswered),
      changeable: answer !== null && open?.flow === step.flow && i + 2 === messages.length - 1,
    })
  })
  return steps
}
