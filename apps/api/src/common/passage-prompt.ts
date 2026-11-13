import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * The one-shot "answer from what you are given" prompt: the rules in the
 * system turn, the material beside the question in the user turn. Lifted from
 * the published site's Ask when a memory bank's reflect (#986) needed the same
 * shape. `material` is the caller's `wrapUntrusted` output — whatever it
 * holds, it sits in the user turn and never in the rules.
 */
export function passageMessages(system: string, material: string, question: string): ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${material}\n\nQuestion: ${question}` },
  ];
}
