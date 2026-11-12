import type { BlueprintGlossaryTerm } from '@knowledge/contracts';

/**
 * The Describe it interview (#731): the terms a round may offer. The round
 * reader and the transcript are shared (`assistant/interview-round.ts`).
 */

const TERMS_MAX = 15;

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
