import {
  BLUEPRINT_INTERVIEW_MAX_OPTIONS,
  BLUEPRINT_INTERVIEW_MAX_QUESTIONS,
  type BlueprintGlossaryTerm,
  type BlueprintInterviewAnswer,
  type BlueprintInterviewRound,
} from '@knowledge/contracts';
import { readPromptFields } from '../assistant/prompt-fields.js';

/**
 * The Describe it interview (#731), the pure half: what the scaffolder's round
 * may hold, the terms it may offer, and the transcript the next call reads.
 */

const TERMS_MAX = 15;

/** The questions of one round, capped and cleaned; empty means the model asked nothing usable. */
export function readRound(raw: unknown): BlueprintInterviewRound {
  return { questions: readPromptFields(raw, { fields: BLUEPRINT_INTERVIEW_MAX_QUESTIONS, options: BLUEPRINT_INTERVIEW_MAX_OPTIONS }).fields };
}

/** Glossary terms a call read off the person's words: a term and a definition each, deduped by spelling. */
export function readTerms(raw: unknown): BlueprintGlossaryTerm[] {
  const seen = new Set<string>();
  const out: BlueprintGlossaryTerm[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const term = typeof t.term === 'string' ? t.term.trim().slice(0, 120) : '';
    const definition = typeof t.definition === 'string' ? t.definition.trim().slice(0, 1_000) : '';
    if (!term || !definition || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push({ term, definition });
    if (out.length >= TERMS_MAX) break;
  }
  return out;
}

/**
 * The rounds so far as the model reads them: each question with the person's
 * answer, option values read back as their labels. Text only — the caller
 * wraps it untrusted, since the client sends the questions back too.
 */
export function transcriptOf(rounds: readonly BlueprintInterviewRound[]): string {
  const answerText = (q: BlueprintInterviewRound['questions'][number], a: BlueprintInterviewAnswer | undefined) => {
    if (a == null || (Array.isArray(a) && !a.length) || a === '') return '(skipped)';
    const label = (v: string) => (q.type === 'text' ? v : (q.options.find((o) => o.value === v)?.label ?? v));
    return (Array.isArray(a) ? a : [a]).map((v) => label(String(v)).slice(0, 1_000)).join('; ');
  };
  return rounds
    .map((round, i) =>
      [`Round ${i + 1}`, ...readRound(round.questions).questions.map((q) => `Q: ${q.label}\nA: ${answerText(q, round.answers?.[q.name])}`)].join('\n'),
    )
    .join('\n\n');
}
