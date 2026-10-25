/**
 * The arbiter's deterministic half (#81): which passages are worth asking a
 * model about, how a judgement is read and checked, and what makes two
 * findings the same conflict. Nest-free, so it is testable alone.
 *
 * The model only ever judges a pair this file chose, and its answer only
 * stands if both quotes are really in the passages it was shown — enforced
 * here, at the point of action, not asked for in the prompt.
 */
import { createHash } from 'node:crypto';
import { cosine } from './coverage.js';
import { askEach } from '../common/ask-each.js';

export interface CandidateChunk {
  chunkId: string;
  documentId: string;
  text: string;
  embedding: number[];
}

export interface CandidatePair {
  a: CandidateChunk;
  b: CandidateChunk;
  similarity: number;
}

/** Pages that share an entity get this much slack below the similarity floor. */
export const SHARED_ENTITY_SLACK = 0.1;

/**
 * Pairs of passages from different pages close enough to be about the same
 * thing — the only passages that can contradict each other. At least one side
 * is in `scope` (the pages that changed, or the one just indexed), so a run
 * re-judges what moved, not the whole workspace.
 *
 * Two pages that share an entity (`sharesEntity`) are held to a lower floor:
 * the graph already says they talk about the same thing. One pair per pair of
 * pages, the closest, so one long page cannot spend the budget on itself; the
 * closest pairs first, capped at `cap`.
 *
 * O(n·m) cosine over scope × corpus: a run's scope is small; the corpus is the
 * live chunk scan, capped where it is read.
 */
export function candidatePairs(
  chunks: readonly CandidateChunk[],
  scope: ReadonlySet<string> | null,
  opts: { minSimilarity: number; cap: number; sharesEntity?: (a: string, b: string) => boolean },
): CandidatePair[] {
  const inScope = (c: CandidateChunk) => !scope || scope.has(c.documentId);
  const best = new Map<string, CandidatePair>();
  const left = chunks.filter(inScope);
  for (const a of left) {
    for (const b of chunks) {
      if (a.documentId === b.documentId) continue;
      // A pair with both sides in scope is met twice; keep one orientation.
      if (inScope(b) && b.chunkId < a.chunkId) continue;
      if (a.embedding.length !== b.embedding.length || a.embedding.length === 0) continue;
      const similarity = cosine(a.embedding, b.embedding);
      const floor = opts.minSimilarity - (opts.sharesEntity?.(a.documentId, b.documentId) ? SHARED_ENTITY_SLACK : 0);
      if (similarity < floor) continue;
      const key = [a.documentId, b.documentId].sort().join(' ');
      const held = best.get(key);
      if (!held || similarity > held.similarity) best.set(key, { a, b, similarity });
    }
  }
  return [...best.values()].sort((x, y) => y.similarity - x.similarity).slice(0, opts.cap);
}

/** What the judge returns for a pair. */
export interface Judgement {
  contradicts: boolean;
  aQuote: string;
  bQuote: string;
  explanation: string;
  confidence: number;
}

/** Whitespace-folded, so a quote that re-wrapped a line still matches. */
const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** A quote stands only if it is a substring of the passage it claims to come from. */
export function quoteIn(passage: string, quote: string): boolean {
  const q = fold(quote);
  return q.length >= 3 && fold(passage).includes(q);
}

/**
 * Read the judge's JSON into a judgement worth keeping, or null: not a
 * contradiction, under the confidence floor, missing a part, or quoting text
 * the passage does not contain.
 */
export function readJudgement(raw: unknown, pair: CandidatePair, minConfidence: number): Judgement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.contradicts !== true) return null;
  const confidence = typeof r.confidence === 'number' ? r.confidence : Number.NaN;
  if (!(confidence >= minConfidence && confidence <= 1)) return null;
  const aQuote = typeof r.aQuote === 'string' ? r.aQuote.trim() : '';
  const bQuote = typeof r.bQuote === 'string' ? r.bQuote.trim() : '';
  const explanation = typeof r.explanation === 'string' ? r.explanation.trim() : '';
  if (!explanation || !quoteIn(pair.a.text, aQuote) || !quoteIn(pair.b.text, bQuote)) return null;
  return { contradicts: true, aQuote, bQuote, explanation: explanation.slice(0, 2000), confidence };
}

/**
 * The identity of a conflict: both pages and both folded quotes, order-free.
 * Not the revision — a page edited elsewhere still says the same contradictory
 * thing, and a conflict somebody dismissed must stay dismissed when found again.
 */
export function conflictFingerprint(sides: Array<{ documentId: string; quote: string }>): string {
  const parts = sides.map((s) => `${s.documentId}\u0000${fold(s.quote)}`).sort();
  return createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

/**
 * The decision model's question for a pair (#530), as measured in
 * docs/features/67: a noul over both passages, page text wrapped untrusted by
 * the caller.
 */
export const CONTRADICTION_QUESTION = {
  instructions: 'Do passage A and passage B contradict each other, so that a reader cannot believe both?',
  criteria: {
    true: 'They state different values, rules, owners or behaviours for the same thing.',
    false: 'They differ only in scope, emphasis, detail, wording or recency, or they are about different things.',
  },
};

/**
 * Ask the decision model about every pair and keep, in order, those it puts at
 * or above `threshold` (#530). Fail-open: a pair whose question failed, or was
 * never asked because a fatal error stopped the asking, is kept, so it goes to
 * the judge as it did before.
 */
export async function prefilterPairs<P>(
  pairs: readonly P[],
  ask: (pair: P) => Promise<number>,
  threshold: number,
  isFatal: (error: unknown) => boolean,
): Promise<{ kept: P[]; asked: number; stopped: unknown }> {
  const { answers, stopped } = await askEach(pairs, ask, isFatal);
  return {
    kept: pairs.filter((_, i) => answers[i] === null || answers[i]! >= threshold),
    asked: answers.filter((p) => p !== null).length,
    stopped,
  };
}
