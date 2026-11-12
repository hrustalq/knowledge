import { INTERVIEW_MAX_OPTIONS, INTERVIEW_MAX_QUESTIONS, type InterviewAnswer, type InterviewRound } from '@knowledge/contracts';
import { readPromptFields } from './prompt-fields.js';

/**
 * A model-led interview, the pure half every asker shares (Describe it #731,
 * workspace purpose #934): what one round may hold and the transcript the
 * next call reads. An asker with tighter caps passes its own.
 */

export interface RoundLimits {
  questions: number;
  options: number;
}

const DEFAULT_LIMITS: RoundLimits = { questions: INTERVIEW_MAX_QUESTIONS, options: INTERVIEW_MAX_OPTIONS };

/** The questions of one round, capped and cleaned; empty means the model asked nothing usable. */
export function readRound(raw: unknown, limits: RoundLimits = DEFAULT_LIMITS): InterviewRound {
  return { questions: readPromptFields(raw, { fields: limits.questions, options: limits.options }).fields };
}

/**
 * The rounds so far as the model reads them: each question with the person's
 * answer, option values read back as their labels. Text only — the caller
 * wraps it untrusted, since the client sends the questions back too.
 */
export function transcriptOf(rounds: readonly InterviewRound[], limits: RoundLimits = DEFAULT_LIMITS): string {
  const answerText = (q: InterviewRound['questions'][number], a: InterviewAnswer | undefined) => {
    if (a == null || (Array.isArray(a) && !a.length) || a === '') return '(skipped)';
    const label = (v: string) => (q.type === 'text' ? v : (q.options.find((o) => o.value === v)?.label ?? v));
    return (Array.isArray(a) ? a : [a]).map((v) => label(String(v)).slice(0, 1_000)).join('; ');
  };
  return rounds
    .map((round, i) =>
      [`Round ${i + 1}`, ...readRound(round.questions, limits).questions.map((q) => `Q: ${q.label}\nA: ${answerText(q, round.answers?.[q.name])}`)].join('\n'),
    )
    .join('\n\n');
}
