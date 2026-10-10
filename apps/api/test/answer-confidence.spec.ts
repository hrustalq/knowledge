import { describe, expect, it } from 'vitest';
import type { AnswerSignals } from '@knowledge/contracts';
import { ANSWER_CONFIDENCE_WEIGHTS, assessAnswer, verificationStateFor } from '@knowledge/contracts';

/**
 * The two pure functions in contracts that three consumers share
 * (docs/features/38): the API stores what `assessAnswer` returns, the web
 * explains its reasons, and the backtest will recompute it. Pinned here so a
 * weight change is a deliberate edit to a failing test, not a drift.
 */

const clean: AnswerSignals = {
  sentences: 4,
  citedSentences: 4,
  sources: 2,
  citedSources: 2,
  unknownCitations: 0,
  maxScore: 0.82,
  staleSources: 0,
  flaggedSources: 0,
  verifiedSources: 2,
  inferredOnly: false,
  toolErrors: 0,
  budgetExhausted: false,
};

describe('assessAnswer', () => {
  it('is none with no sources, whatever the text did', () => {
    const c = assessAnswer({ ...clean, sources: 0, citedSources: 0, citedSentences: 0 });
    expect(c).toEqual({ level: 'none', score: 0, reasons: [{ key: 'no-sources', value: 0 }] });
  });

  it('is high for full coverage from verified, fresh pages', () => {
    const c = assessAnswer(clean);
    expect(c.level).toBe('high');
    expect(c.score).toBe(1);
    expect(c.reasons).toEqual([{ key: 'verified-sources', value: 2 }]);
  });

  it('loses coverage linearly and names the uncited count', () => {
    const c = assessAnswer({ ...clean, citedSentences: 2, verifiedSources: 2 });
    expect(c.reasons).toContainEqual({ key: 'uncited-sentences', value: 2 });
    // 1 − 0.45 × (2/4) + 0.1 verified bonus, capped at 1.
    expect(c.score).toBe(Math.round((1 - ANSWER_CONFIDENCE_WEIGHTS.coverage * 0.5 + ANSWER_CONFIDENCE_WEIGHTS.verified) * 1000) / 1000);
    expect(c.level).toBe('high');
  });

  it('is low when nothing is cited and the search was weak', () => {
    const c = assessAnswer({ ...clean, citedSentences: 0, citedSources: 0, verifiedSources: 0, maxScore: 0.2 });
    expect(c.level).toBe('low');
    expect(c.reasons.map((r) => r.key)).toEqual(['uncited-sentences', 'low-retrieval-score']);
  });

  it('counts unknown labels, with a cap', () => {
    const one = assessAnswer({ ...clean, unknownCitations: 1 });
    const many = assessAnswer({ ...clean, unknownCitations: 9 });
    expect(one.reasons).toContainEqual({ key: 'unknown-citation', value: 1 });
    expect(many.score).toBeGreaterThanOrEqual(one.score - ANSWER_CONFIDENCE_WEIGHTS.unknownCitationCap);
    expect(many.score).toBe(Math.round((1 - ANSWER_CONFIDENCE_WEIGHTS.unknownCitationCap + ANSWER_CONFIDENCE_WEIGHTS.verified) * 1000) / 1000);
  });

  it('withholds the verified bonus when a cited page is flagged', () => {
    const c = assessAnswer({ ...clean, flaggedSources: 1 });
    expect(c.reasons.map((r) => r.key)).toEqual(['flagged-sources']);
    expect(c.level).toBe('medium');
  });

  it('penalizes inferred-only evidence, spent budget and tool errors', () => {
    const c = assessAnswer({ ...clean, verifiedSources: 0, inferredOnly: true, budgetExhausted: true, toolErrors: 5 });
    expect(c.reasons.map((r) => r.key)).toEqual(['inferred-only', 'tool-errors', 'budget-exhausted']);
    const expected = 1 - ANSWER_CONFIDENCE_WEIGHTS.inferredOnly - ANSWER_CONFIDENCE_WEIGHTS.toolErrorCap - ANSWER_CONFIDENCE_WEIGHTS.budgetExhausted;
    expect(c.score).toBe(Math.round(expected * 1000) / 1000);
    expect(c.level).toBe('low');
  });

  it('never leaves the 0..1 range', () => {
    const c = assessAnswer({
      ...clean,
      citedSentences: 0,
      citedSources: 0,
      verifiedSources: 0,
      unknownCitations: 20,
      staleSources: 2,
      flaggedSources: 2,
      inferredOnly: true,
      toolErrors: 20,
      budgetExhausted: true,
      maxScore: 0,
    });
    expect(c.score).toBe(0);
    expect(c.level).toBe('low');
  });
});

describe('verificationStateFor', () => {
  it('reads the stamp against the head', () => {
    expect(verificationStateFor({ verifiedRevisionId: null }, 'r2', 0)).toBe('unverified');
    expect(verificationStateFor({ verifiedRevisionId: 'r2' }, 'r2', 0)).toBe('verified');
    expect(verificationStateFor({ verifiedRevisionId: 'r1' }, 'r2', 0)).toBe('outdated');
    expect(verificationStateFor({ verifiedRevisionId: 'r2' }, null, 0)).toBe('outdated');
  });

  it('is flagged whenever a report is open, stamp or not', () => {
    expect(verificationStateFor({ verifiedRevisionId: 'r2' }, 'r2', 1)).toBe('flagged');
    expect(verificationStateFor({ verifiedRevisionId: null }, 'r2', 3)).toBe('flagged');
  });
});
