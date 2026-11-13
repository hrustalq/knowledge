import { wrapUntrusted } from '../common/untrusted.js';

/**
 * The pure half of consolidation (#993): the consolidator's prompt, reading
 * its answer back, and what that answer writes. No model, no store.
 */

/** A fact or an observation as the consolidator is shown it: its label is its index + 1. */
export interface Shown {
  text: string;
}

/** One entry of the answer the reader kept: an observation to create (`target` null) or refine. */
export interface ConsolidationEntry {
  /** Index into the observations shown, or null for a new observation. */
  target: number | null;
  /** The new wording; null on a refine that only adds evidence. Never null on a new one. */
  text: string | null;
  /** Index into the facts shown, and a quote verbatim in that fact. At least one. */
  evidence: Array<{ fact: number; quote: string }>;
}

const MAX_OBSERVATION_CHARS = 2000;
const MAX_QUOTE_CHARS = 1000;

/** The user message of one consolidation call: the facts and the observations, each under its label, wrapped untrusted. */
export function consolidationPrompt(facts: Shown[], observations: Shown[], mission: string): string {
  const list = (items: Shown[], prefix: string) => items.map((x, i) => `${prefix}${i + 1}: ${x.text}`).join('\n');
  return [
    mission ? `What this memory bank is for: ${mission}` : '',
    `New facts:\n${wrapUntrusted(list(facts, 'F'), 'consolidate', 'memory')}`,
    `Existing observations:\n${observations.length ? wrapUntrusted(list(observations, 'O'), 'consolidate', 'memory') : '(none yet)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const labelIndex = (value: unknown, prefix: 'F' | 'O', count: number): number | null => {
  const m = typeof value === 'string' ? new RegExp(`^${prefix}(\\d+)$`).exec(value.trim()) : null;
  const i = m ? Number(m[1]) - 1 : -1;
  return i >= 0 && i < count ? i : null;
};

/**
 * The model's answer, reduced to what it may say. Evidence must name a fact
 * label that was handed out and quote it **verbatim** — the quote is the
 * observation's proof, and a paraphrase proves nothing — or it is dropped. An
 * entry left with no evidence is dropped, as is one naming an observation
 * label that was not handed out, a new one with no text, and a second entry
 * for an observation already refined.
 */
export function readConsolidation(raw: unknown, facts: Shown[], observations: Shown[]): ConsolidationEntry[] {
  const entries = (raw as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(entries)) return [];
  const out: ConsolidationEntry[] = [];
  const refined = new Set<number>();
  for (const e of entries as Array<Record<string, unknown> | null>) {
    if (!e || typeof e !== 'object') continue;
    const named = e.observation != null;
    const target = named ? labelIndex(e.observation, 'O', observations.length) : null;
    if (named && target === null) continue;
    if (target !== null && refined.has(target)) continue;
    const text = typeof e.text === 'string' && e.text.trim() ? e.text.trim().slice(0, MAX_OBSERVATION_CHARS) : null;
    if (target === null && !text) continue;
    const evidence: ConsolidationEntry['evidence'] = [];
    for (const ev of Array.isArray(e.evidence) ? (e.evidence as Array<Record<string, unknown> | null>) : []) {
      const fact = labelIndex(ev?.fact, 'F', facts.length);
      const quote = typeof ev?.quote === 'string' ? ev.quote.trim() : '';
      if (fact === null || !quote || quote.length > MAX_QUOTE_CHARS || !facts[fact]!.text.includes(quote)) continue;
      if (!evidence.some((x) => x.fact === fact)) evidence.push({ fact, quote });
    }
    if (!evidence.length) continue;
    if (target !== null) refined.add(target);
    out.push({ target, text, evidence });
  }
  return out;
}

/**
 * What a refine writes, given the observation's text **as it is now** (read
 * under the bank's lock, not as the model was shown it): the new wording, and
 * the text it replaces for the history row — null when the wording is
 * unchanged. Evidence is only ever added; nothing here removes any.
 */
export function refinement(current: string, entry: Pick<ConsolidationEntry, 'text'>): { text: string; previous: string | null } {
  const text = entry.text ?? current;
  return { text, previous: text === current ? null : current };
}

/** The UTC day a consolidation call is counted against, as `YYYY-MM-DD` for the `date` column. */
export const consolidationDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
