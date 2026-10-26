import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SEARCH_COMMUNITY_PRIOR_FLOOR,
  SEARCH_COMMUNITY_PRIOR_WEIGHT,
  SEARCH_MIN_COSINE_SHARE,
  SEARCH_RRF_K,
  TRUST_WEIGHTS,
  type FeedbackBacktestCase,
  type SourceVerificationState,
} from '@knowledge/contracts';
import { VerificationPolicyService } from '../src/verification/verification-policy.service.js';
import { isHoldout, tuneSearch, tuneThreshold, dedupeCost, type Replay } from '../src/search/tuning.js';
import type { SearchPool } from '../src/search/ranking.js';
import type { CaseScores } from '../src/captures/capture-calibration.js';

/**
 * `make tune` (#305, phase 4): an empty override ranks as the constants did,
 * and a proposal is only emitted when the holdout agrees with the train split.
 */

const CURRENT = {
  rrfK: SEARCH_RRF_K,
  minCosine: 0,
  minCosineShare: 0,
  communityPriorWeight: SEARCH_COMMUNITY_PRIOR_WEIGHT,
  communityPriorFloor: SEARCH_COMMUNITY_PRIOR_FLOOR,
  trustWeights: TRUST_WEIGHTS,
};

function policy(row: Record<string, unknown> | null) {
  const prisma = { knowledgeHealthSettings: { findUnique: vi.fn(async () => row), upsert: vi.fn(async () => ({})) } };
  const config = { get: vi.fn(() => 1) };
  // The read cache off: every read goes to the source, as with READ_CACHE_ENABLED=false.
  const cache = { wrap: (_ns: string, _key: string, load: () => Promise<unknown>) => load(), invalidate: async () => undefined };
  return { svc: new VerificationPolicyService(prisma as never, config as never, cache as never), prisma };
}

describe('search knobs settings', () => {
  it('an empty row, or no row, resolves to the code constants', async () => {
    for (const row of [null, { rrfK: null, minCosine: null, minCosineShare: null, trustWeights: null }]) {
      const effective = await policy(row).svc.effective('ws');
      expect(effective.rrfK).toBe(SEARCH_RRF_K);
      expect(effective.minCosineShare).toBe(SEARCH_MIN_COSINE_SHARE);
      // SEARCH_MIN_COSINE: the stub config answers 1 for every key.
      expect(effective.minCosine).toBe(1);
      expect(effective.trustWeights).toEqual(TRUST_WEIGHTS);
      // #475: no prior and the flat walk, so an empty row ranks as before.
      expect([effective.communityPriorWeight, effective.layeredExpansion]).toEqual([0, false]);
    }
  });

  it('a weight override is sparse: one state changes, the rest keep their defaults', async () => {
    const effective = await policy({ rrfK: 30, trustWeights: { outdated: 0.3 } }).svc.effective('ws');
    expect(effective.rrfK).toBe(30);
    expect(effective.trustWeights).toEqual({ ...TRUST_WEIGHTS, outdated: 0.3 });
  });

  it('null resets the weights to SQL NULL, not a JSON null', async () => {
    const { svc, prisma } = policy(null);
    await svc.update('ws', { trustWeights: null });
    expect(prisma.knowledgeHealthSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { trustWeights: Prisma.DbNull } }));
  });
});

/** Queries that land in the split asked for, so the cases do not depend on the hash's luck. */
function queries(holdout: boolean, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (isHoldout(`q${i}`) === holdout) out.push(`q${i}`);
  return out;
}

/** Two pages, `a` unverified and `b` verified, scored by the vector leg alone. */
function replay(query: string, expected: 'a' | 'b', a: number, b: number): Replay {
  const hit = (documentId: string, score: number) => ({ documentId, chunkId: documentId, revisionId: 'r', text: '', headingPath: [], score });
  const page = (status: SourceVerificationState) => ({ status, inactive: false, archived: false });
  const pool: SearchPool = {
    vectorHits: [hit('a', a), hit('b', b)].sort((x, y) => y.score - x.score),
    textHits: [],
    communities: [],
    fetchK: 20,
    k: 10,
    trustOn: true,
    pages: new Map([
      ['a', page('unverified')],
      ['b', page('verified')],
    ]),
  };
  const c = { workspaceId: 'ws', query, expectedDocumentIds: [expected], rejectedDocumentIds: [] } as unknown as FeedbackBacktestCase;
  return { case: c, pool };
}

describe('tuneSearch', () => {
  // Train: `a` should win, but the verified boost (0.5 × 1.15 > 0.56) puts `b`
  // first — a `verified` weight under 1.12 fixes it, and 1.10 is the nearest.
  const train = queries(false, 3).map((q) => replay(q, 'a', 0.56, 0.5));

  it('proposes the smallest move that fixes the train split when the holdout agrees', () => {
    const holdout = queries(true, 2).map((q) => replay(q, 'a', 0.56, 0.5));
    const t = tuneSearch([...train, ...holdout], [], CURRENT, 10);
    expect(t.proposal).not.toBeNull();
    expect(t.proposal!.trustWeights.verified).toBeCloseTo(1.1);
    expect(t.proposal!.rrfK).toBe(SEARCH_RRF_K);
    expect(t.feedback.holdout.candidate.mrr).toBeGreaterThan(t.feedback.holdout.current.mrr);
  });

  it('proposes nothing when the holdout regresses', () => {
    // Holdout: `b` should win and only does while verified > 1.14.
    const holdout = queries(true, 2).map((q) => replay(q, 'b', 0.57, 0.5));
    const t = tuneSearch([...train, ...holdout], [], CURRENT, 10);
    expect(t.candidate.trustWeights.verified).toBeLessThan(1.12);
    expect(t.proposal).toBeNull();
    expect(t.reason).toMatch(/holdout MRR/);
  });

  it('proposes a floor when weak vector evidence is what outranks the answer (#401)', () => {
    // `a` answers, first in BM25 only. `b` is second in BM25 and far behind the
    // vector leg's best, yet both legs naming it gives 2/62 > 1/61. Trust is
    // off, so no weight moves anything and no rrfK helps; dropping `b`'s vector
    // evidence (share 0.8 of 0.9 = 0.72 > 0.5) does.
    const hit = (documentId: string, score: number) => ({ documentId, chunkId: documentId, revisionId: 'r', text: '', headingPath: [], score });
    const page = { status: 'unverified' as const, inactive: false, archived: false };
    const cases = [...queries(false, 3), ...queries(true, 2)].map(
      (query): Replay => ({
        case: { workspaceId: 'ws', query, expectedDocumentIds: ['a'], rejectedDocumentIds: [] } as unknown as FeedbackBacktestCase,
        pool: {
          vectorHits: [hit('c', 0.9), hit('b', 0.5)],
          textHits: [hit('a', 9), hit('b', 8)],
          fetchK: 20,
          k: 10,
          trustOn: false,
          pages: new Map(['a', 'b', 'c'].map((id) => [id, page])),
          communities: [],
        },
      }),
    );
    const t = tuneSearch(cases, [], CURRENT, 10);
    expect(t.proposal).toEqual({ ...CURRENT, minCosineShare: 0.8 });
    expect(t.feedback.holdout.candidate.mrr).toBeGreaterThan(t.feedback.holdout.current.mrr);
  });

  it('proposes nothing without a labelled vote', () => {
    expect(tuneSearch([], [], CURRENT, 10).proposal).toBeNull();
  });
});

describe('tuneThreshold (the #234 floor)', () => {
  const probe = (own: number, other = 0) => ({ own, other });
  // Restatements at 0.85 are missed at 0.92 but caught at 0.84 — which would
  // also drop the same-title new facts at 0.86. The floor refuses that trade.
  const cases: CaseScores[] = Array.from({ length: 20 }, () => ({
    amend: probe(0.7),
    restatement: probe(0.85),
    sameTitle: probe(0.86),
  }));
  const keys = cases.map((_, i) => `page-${i}`);

  it('never lowers dedupe into dropping more new knowledge, however many restatements it would catch', () => {
    const t = tuneThreshold(cases, keys, 0.92, dedupeCost);
    expect(t.candidate).toBeGreaterThan(0.86);
    expect(t.proposal).toBeNull();
  });

  it('moves when a threshold is better on both splits without more of the costly error', () => {
    const easy = cases.map((c) => ({ ...c, sameTitle: probe(0.6) }));
    const t = tuneThreshold(easy, keys, 0.92, dedupeCost);
    expect(t.proposal).toBe(0.84);
    expect(t.holdout.candidate.sum).toBeLessThan(t.holdout.current.sum);
  });
});
