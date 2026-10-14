import { ANSWER_FEEDBACK_REASONS, type AnswerFeedbackReason, type AnswerRating } from '@knowledge/contracts';

/**
 * What a button under a bot message means, written into the button's data
 * (issue #71, phase 2). The platform hands the data back untouched and only
 * for buttons this bot sent, so it needs no signature — but it is still read
 * as untrusted input: anything that does not decode is ignored, and the answer
 * it names is looked up in the chat the press came from.
 *
 * Compact on purpose: Telegram allows 64 bytes, and the longest form here —
 * `r:<uuid>:irrelevant-sources` — is 57.
 */
export type ChatAction =
  | { kind: 'vote'; answerId: string; rating: AnswerRating }
  | { kind: 'reason'; answerId: string; reason: AnswerFeedbackReason }
  /** Put the vote row back without choosing a reason. */
  | { kind: 'back'; answerId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeChatAction(action: ChatAction): string {
  switch (action.kind) {
    case 'vote':
      return `v:${action.answerId}:${action.rating === 'up' ? 'u' : 'd'}`;
    case 'reason':
      return `r:${action.answerId}:${action.reason}`;
    case 'back':
      return `b:${action.answerId}`;
  }
}

export function decodeChatAction(data: string): ChatAction | null {
  const [tag, answerId, arg, ...rest] = data.split(':');
  if (rest.length || !answerId || !UUID_RE.test(answerId)) return null;
  if (tag === 'v' && (arg === 'u' || arg === 'd')) return { kind: 'vote', answerId, rating: arg === 'u' ? 'up' : 'down' };
  if (tag === 'r' && (ANSWER_FEEDBACK_REASONS as readonly string[]).includes(arg)) {
    return { kind: 'reason', answerId, reason: arg as AnswerFeedbackReason };
  }
  if (tag === 'b' && arg === undefined) return { kind: 'back', answerId };
  return null;
}
