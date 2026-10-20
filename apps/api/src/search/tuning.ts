import type { FeedbackBacktestCase, FeedbackMetrics, TrustWeights } from '@knowledge/contracts';
import { scoreFeedbackCase, summarizeFeedbackScores } from '@knowledge/contracts';
import { amendErrors, dedupeErrors, fnv, thresholdGrid, type CaseScores } from '../captures/capture-calibration.js';
import { rankPool, type SearchKnobs, type SearchPool } from './ranking.js';

/**
 * The pure half of `make tune` (#305, phase 4). `backtest.main.ts --tune` does
 * the I/O: one search per query records its pool, and everything here
 * re-ranks those pools in memory, so a candidate costs microseconds and the
 * stores are asked once.
 *
 * The tuner only proposes. Every number it prints is applied, or not, by a
 * person through the settings routes.
 */

/** Share of each set held out of the search and reported separately. */
export const HOLDOUT_SHARE = 0.3;
/** Known-item recall@5 may fall this much (a share, so one point) for a better MRR, and no more. */
export const MAX_RECALL_DROP = 0.01;
export const KNOWN_ITEM_K = 5;

export const RRF_K_GRID = [10, 20, 30, 40, 60, 80, 100, 150, 200];
/** The states the tuner moves. unverified/requested/edited stay the reference 1: scaling everything ranks nothing differently. */
export const TUNED_WEIGHTS = ['verified', 'expired', 'flagged', 'outdated', 'inactive'] as const satisfies readonly (keyof TrustWeights)[];
/** 0.30 … 1.25: the settings route's bounds, minus the extremes nobody should ship. */
export const WEIGHT_GRID = thresholdGrid(30, 125, 5);

/** Stable per key, so a re-run splits the same way and a proposal can be reproduced. */
export const isHoldout = (key: string): boolean => fnv(key) % 100 < HOLDOUT_SHARE * 100;

/** One labelled query and the pool its search recorded; `null` when it retrieved nothing. */
export interface Replay {
  case: FeedbackBacktestCase;
  pool: SearchPool | null;
}

function evaluate(replays: readonly Replay[], knobs: SearchKnobs, k: number): FeedbackMetrics {
  return summarizeFeedbackScores(replays.map((r) => scoreFeedbackCase(r.case, r.pool ? rankPool(r.pool, knobs) : [], k)));
}

const recall = (m: FeedbackMetrics) => (m.withExpected ? m.hitAtK / m.withExpected : 0);

/** One coordinate of the descent: its grid, and how to read and write it on a knob set. */
interface Axis {
  name: string;
  values: readonly number[];
  get: (k: SearchKnobs) => number;
  set: (k: SearchKnobs, v: number) => SearchKnobs;
}

const AXES: readonly Axis[] = [
  { name: 'rrfK', values: RRF_K_GRID, get: (k) => k.rrfK, set: (k, v) => ({ ...k, rrfK: v }) },
  ...TUNED_WEIGHTS.map(
    (state): Axis => ({
      name: `trustWeights.${state}`,
      values: WEIGHT_GRID,
      get: (k) => k.trustWeights[state],
      set: (k, v) => ({ ...k, trustWeights: { ...k.trustWeights, [state]: v } }),
    }),
  ),
];

/**
 * Coordinate descent from `start`: each axis in turn takes the grid value that
 * scores best, and only a strict improvement moves it, so a flat objective
 * (trust ranking off, say) leaves the incumbent where it is. Values are tried
 * nearest first, so of equally good moves the smallest wins.
 */
export function descend(start: SearchKnobs, score: (k: SearchKnobs) => number, admissible: (k: SearchKnobs) => boolean, passes = 3): SearchKnobs {
  let best = start;
  let bestScore = score(start);
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const axis of AXES) {
      const from = axis.get(best);
      for (const v of [...axis.values].sort((a, b) => Math.abs(a - from) - Math.abs(b - from))) {
        if (v === axis.get(best)) continue;
        const candidate = axis.set(best, v);
        if (!admissible(candidate)) continue;
        const s = score(candidate);
        if (s > bestScore + 1e-9) {
          best = candidate;
          bestScore = s;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return best;
}

export interface SplitMetrics {
  current: FeedbackMetrics;
  candidate: FeedbackMetrics;
}

export interface SearchTuning {
  current: SearchKnobs;
  candidate: SearchKnobs;
  feedback: { train: SplitMetrics; holdout: SplitMetrics };
  knownItems: { train: SplitMetrics; holdout: SplitMetrics };
  /** The knobs to apply, or null with `reason` saying why nothing is proposed. */
  proposal: SearchKnobs | null;
  reason: string;
}

/**
 * Objective: MRR on the feedback cases. Constraint: known-item recall@5 falls
 * at most one point. Both are tuned on the train split and must hold on the
 * holdout too — a candidate that only fits the cases it was tuned on is not
 * proposed.
 */
export function tuneSearch(feedback: readonly Replay[], knownItems: readonly Replay[], current: SearchKnobs, k: number): SearchTuning {
  const split = (rs: readonly Replay[]) => ({
    train: rs.filter((r) => !isHoldout(r.case.query)),
    holdout: rs.filter((r) => isHoldout(r.case.query)),
  });
  const fb = split(feedback);
  const ki = split(knownItems);
  const kiFloor = recall(evaluate(ki.train, current, KNOWN_ITEM_K)) - MAX_RECALL_DROP;
  const candidate = descend(
    current,
    (knobs) => evaluate(fb.train, knobs, k).mrr,
    (knobs) => recall(evaluate(ki.train, knobs, KNOWN_ITEM_K)) >= kiFloor,
  );
  const measure = (rs: readonly Replay[], kk: number): SplitMetrics => ({ current: evaluate(rs, current, kk), candidate: evaluate(rs, candidate, kk) });
  const result = {
    current,
    candidate,
    feedback: { train: measure(fb.train, k), holdout: measure(fb.holdout, k) },
    knownItems: { train: measure(ki.train, KNOWN_ITEM_K), holdout: measure(ki.holdout, KNOWN_ITEM_K) },
  };
  const why = searchVerdict(result);
  return { ...result, proposal: why ? null : candidate, reason: why ?? 'train and holdout both improve' };
}

/** Null when the candidate may be proposed, else why not. */
function searchVerdict(t: Omit<SearchTuning, 'proposal' | 'reason'>): string | null {
  if (t.feedback.train.current.withExpected === 0) return 'no feedback case names an expected page — nothing to tune against';
  if (JSON.stringify(t.candidate) === JSON.stringify(t.current)) return 'no grid value beats the current knobs on the train split';
  const { holdout } = t.feedback;
  if (holdout.current.withExpected === 0) return 'the holdout has no labelled case to confirm the gain';
  if (holdout.candidate.mrr <= holdout.current.mrr) return 'the holdout MRR does not improve';
  if (recall(t.knownItems.holdout.candidate) < recall(t.knownItems.holdout.current) - MAX_RECALL_DROP) {
    return 'known-item recall@5 drops more than one point on the holdout';
  }
  return null;
}

export interface ThresholdTuning {
  current: number;
  candidate: number;
  train: { current: ThresholdErrors; candidate: ThresholdErrors };
  holdout: { current: ThresholdErrors; candidate: ThresholdErrors };
  proposal: number | null;
  reason: string;
}

/** `sum` is every error the calibration counts; `guarded` is the costly one #234 kept the default for. */
export interface ThresholdErrors {
  sum: number;
  guarded: number;
}

/** Dedupe: missed restatements + dropped new facts; a drop loses knowledge nobody reviews. */
export const dedupeCost = (cases: readonly CaseScores[], t: number): ThresholdErrors => {
  const e = dedupeErrors(cases, t);
  return { sum: e.missed + e.dropped, guarded: e.dropped };
};

/** Amend: scattered + wrong page + false amend; a false amend edits a page that had nothing to do with it. */
export const amendCost = (cases: readonly CaseScores[], t: number): ThresholdErrors => {
  const e = amendErrors(cases, t);
  return { sum: e.scattered + e.wrongPage + e.falseAmend, guarded: e.falseAmend };
};

/**
 * The #234 precision floor: a capture threshold moves only to one that makes
 * no more of the costly error than today, with a lower error sum on both
 * splits. `cases[i]` is split by `keys[i]` (its page id).
 */
export function tuneThreshold(
  cases: readonly CaseScores[],
  keys: readonly string[],
  current: number,
  cost: (cases: readonly CaseScores[], t: number) => ThresholdErrors,
  ceiling = 1,
): ThresholdTuning {
  const train = cases.filter((_, i) => !isHoldout(keys[i]));
  const holdout = cases.filter((_, i) => isHoldout(keys[i]));
  const floor = cost(train, current).guarded;
  let candidate = current;
  for (const t of thresholdGrid().filter((t) => t <= ceiling)) {
    const c = cost(train, t);
    if (c.guarded > floor) continue;
    const best = cost(train, candidate).sum;
    if (c.sum < best - 1e-9 || (Math.abs(c.sum - best) < 1e-9 && Math.abs(t - current) < Math.abs(candidate - current))) candidate = t;
  }
  const at = (set: readonly CaseScores[]) => ({ current: cost(set, current), candidate: cost(set, candidate) });
  const result = { current, candidate, train: at(train), holdout: at(holdout) };
  const why =
    train.length === 0 ? 'no calibration case'
    : candidate === current ? 'no threshold beats the current one without more of the costly error'
    : holdout.length === 0 ? 'the holdout has no case to confirm the gain'
    : result.holdout.candidate.sum >= result.holdout.current.sum ? 'the holdout error does not fall'
    : result.holdout.candidate.guarded > result.holdout.current.guarded ? 'the holdout makes more of the costly error'
    : null;
  return { ...result, proposal: why ? null : candidate, reason: why ?? 'train and holdout both improve' };
}
