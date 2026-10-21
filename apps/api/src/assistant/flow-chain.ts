import type { AssistantFlowAnswer, AssistantMessageInfo, FlowAnswers, FlowKey } from '@knowledge/contracts';

/** The tool each flow belongs to — the one the model is told to call again. */
export const FLOW_TOOL: Record<FlowKey, string> = {
  'capture-decision': 'capture_decision',
  'mark-outdated': 'mark_outdated',
};

export interface OpenFlow {
  flow: FlowKey;
  /** This run's answers, oldest first, a later answer to the same question winning. */
  answers: FlowAnswers;
  /** The question the newest prompt asks. */
  open: string;
  /** The question answered most recently — the one "Change" may re-answer. */
  lastAnswered: string | null;
}

type ChainMessage = Pick<AssistantMessageInfo, 'role' | 'prompt' | 'answer'>;

/**
 * The flow a thread is in the middle of, rebuilt from its messages (#425) —
 * there is no flow state table. Walks back from the newest message over an
 * unbroken run of this flow's prompts and answers; anything else (a typed
 * message, a reply that asked nothing, another flow) ends the run. A person who
 * types instead of answering has left the flow, and nothing it asked runs.
 */
export function openFlow(messages: ChainMessage[]): OpenFlow | null {
  const last = messages.at(-1);
  const prompt = last?.role === 'assistant' && last.prompt?.kind === 'form' ? last.prompt : null;
  if (!prompt?.flow || !prompt.questionId) return null;
  const flow = prompt.flow;

  const given: AssistantFlowAnswer[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.prompt?.kind === 'form' && m.prompt.flow === flow) continue;
    if (m.role === 'user' && m.answer?.flow === flow) {
      given.unshift(m.answer);
      continue;
    }
    break;
  }
  const answers: FlowAnswers = {};
  for (const a of given) answers[a.questionId] = a.value;
  return { flow, answers, open: prompt.questionId, lastAnswered: given.at(-1)?.questionId ?? null };
}

/**
 * Whether `answer` may be posted now: to the open question, or as a change to
 * the one answered last. Anything else is an older form submitted late, and is
 * refused before it is stored.
 */
export function acceptsAnswer(open: OpenFlow | null, answer: AssistantFlowAnswer): boolean {
  if (!open || open.flow !== answer.flow) return false;
  return answer.questionId === open.open || answer.questionId === open.lastAnswered;
}
