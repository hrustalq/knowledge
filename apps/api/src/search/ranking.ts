import type { SourceVerificationState, TrustWeights } from '@knowledge/contracts';
import { trustWeight } from '@knowledge/contracts';
import type { ChunkHit } from '../graph/graph.service.js';

/** The knobs a workspace may override and `make tune` proposes (#305, #401, #475). */
export interface SearchKnobs {
  rrfK: number;
  minCosine: number;
  minCosineShare: number;
  /** 0 = no community prior: the ranking is exactly the one before #475. */
  communityPriorWeight: number;
  communityPriorFloor: number;
  trustWeights: TrustWeights;
}

/** A community the reader may see whole, scored against the query (#475). */
export interface PriorCommunity {
  communityId: string;
  level: number;
  parentId: string | null;
  /** Every page beneath it. */
  members: readonly string[];
  /** Cosine of its summary against the query embedding. */
  score: number;
}

/**
 * The community prior (#475, docs/features/63): page → score multiplier.
 *
 * One path: the best community at the coarsest level where any clears the
 * floor, then the best of its children that clears it, down to level 0. A
 * page `d` deep in a path of `n` gets `1 + weight · d/n` — the finest match
 * the full weight — and every other page is absent (×1). It boosts, never
 * filters. Ties go to the smaller id, so the same scores give the same path.
 */
export function communityPrior(
  communities: readonly PriorCommunity[],
  knobs: Pick<SearchKnobs, 'communityPriorWeight' | 'communityPriorFloor'>,
): Map<string, number> {
  const boost = new Map<string, number>();
  if (!(knobs.communityPriorWeight > 0)) return boost;
  const clearing = communities.filter((c) => c.score >= knobs.communityPriorFloor);
  if (clearing.length === 0) return boost;
  const best = (cs: readonly PriorCommunity[]) =>
    cs.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.communityId < a.communityId) ? b : a));
  const top = Math.max(...clearing.map((c) => c.level));
  const path = [best(clearing.filter((c) => c.level === top))];
  for (;;) {
    const children = clearing.filter((c) => c.parentId === path[path.length - 1]!.communityId);
    if (children.length === 0) break;
    path.push(best(children));
  }
  // Coarse to fine: a deeper community overwrites its ancestor's smaller boost.
  path.forEach((c, i) => {
    for (const m of c.members) boost.set(m, 1 + (knobs.communityPriorWeight * (i + 1)) / path.length);
  });
  return boost;
}

/**
 * The relevance floor (#401): the vector hits worth fusing — cosine at least
 * `minCosine` and at least `minCosineShare` of the leg's best. Applied before
 * fusion, so a chunk weak in both legs is gone and one weak in one leg keeps
 * only the other's rank; a search may then return fewer than its limit. Hits
 * arrive best first, so the first is the leg's best.
 */
export function floorVectorHits<T extends Pick<ChunkHit, 'score'>>(hits: T[], knobs: Pick<SearchKnobs, 'minCosine' | 'minCosineShare'>): T[] {
  const min = Math.max(knobs.minCosine, knobs.minCosineShare * (hits[0]?.score ?? 0));
  return hits.filter((h) => h.score >= min);
}

/**
 * The BM25 leg's floor (#416): at least this share of the leg's best score.
 * #400's match demands a share of the query's terms, which two common words
 * still meet («пользователей», «роли»); on prod those sat at about half the
 * best score while the answering chunk led its leg.
 */
export const SEARCH_MIN_TEXT_SHARE = 0.6;

export function floorTextHits<T extends Pick<ChunkHit, 'score'>>(hits: T[]): T[] {
  const min = SEARCH_MIN_TEXT_SHARE * (hits[0]?.score ?? 0);
  return hits.filter((h) => h.score >= min);
}

/**
 * One entry per page, its best-ranked chunk (#416): what a model reads. A page
 * repeated per chunk costs its context window and adds nothing to cite.
 */
export function firstPerPage<T extends { documentId: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    if (seen.has(h.documentId)) return false;
    seen.add(h.documentId);
    return true;
  });
}

/**
 * Merge vector and BM25 rankings. Single-source results keep their native
 * score (BM25 normalized to 0..1 by the max); two-source results use
 * reciprocal rank fusion — raw cosine and BM25 scores are not comparable.
 * Every hit the vector leg found also keeps its raw cosine as `vectorScore`,
 * the one scale that means the same whichever legs answered (#403).
 */
export function fuseHits<T extends Pick<ChunkHit, 'chunkId' | 'score'>>(
  vectorHits: T[],
  textHits: T[],
  k: number,
  rrfK: number,
): (T & { vectorScore?: number })[] {
  const vector = vectorHits.map((h) => ({ ...h, vectorScore: h.score }));
  if (textHits.length === 0) return vector.slice(0, k);
  if (vectorHits.length === 0) {
    const max = Math.max(...textHits.map((h) => h.score), 1e-9);
    return textHits.slice(0, k).map((h) => ({ ...h, score: h.score / max }));
  }
  const fused = new Map<string, T & { vectorScore?: number }>();
  const add = (rank: number, hit: T & { vectorScore?: number }) => {
    const existing = fused.get(hit.chunkId);
    const increment = 1 / (rrfK + rank + 1);
    if (existing) existing.score += increment;
    else fused.set(hit.chunkId, { ...hit, score: increment });
  };
  vector.forEach((h, i) => add(i, h));
  textHits.forEach((h, i) => add(i, h));
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * What one unfiltered search retrieved before anything a knob decides: both
 * legs at `fetchK`, and the state of every page either leg named. The tuner
 * records it once per query and re-ranks it for every candidate knob setting.
 */
export interface SearchPool {
  vectorHits: ChunkHit[];
  textHits: ChunkHit[];
  fetchK: number;
  k: number;
  trustOn: boolean;
  /** Pages the search may return; a hit whose page is absent is dropped, as the PG join drops it. */
  pages: Map<string, { status: SourceVerificationState; inactive: boolean; archived: boolean }>;
  /** The readable communities scored against the query (#475); empty when none, or under `asOf`. */
  communities: PriorCommunity[];
}

/**
 * `SearchService.search` with no filters, from the fusion on: the ranked page
 * ids, one per hit. Kept step for step with the service — the parity case in
 * `search-trust.spec.ts` replays one search through both.
 */
export function rankPool(pool: SearchPool, knobs: SearchKnobs): string[] {
  const prior = communityPrior(pool.communities, knobs);
  // Before the floors, as in the service (#526): a floor measures against a hit the search can return.
  const admits = (h: ChunkHit) => pool.pages.get(h.documentId)?.archived === false;
  const vector = floorVectorHits(pool.vectorHits.filter(admits), knobs);
  const weighted = fuseHits(vector, floorTextHits(pool.textHits.filter(admits)), pool.fetchK, knobs.rrfK).map((h) => {
    const page = pool.pages.get(h.documentId)!;
    const weight = pool.trustOn ? trustWeight(page.status, page.inactive, knobs.trustWeights) : 1;
    return { documentId: h.documentId, score: h.score * weight * (prior.get(h.documentId) ?? 1) };
  });
  if (pool.trustOn || prior.size > 0) weighted.sort((a, b) => b.score - a.score);
  return weighted.slice(0, pool.k).map((w) => w.documentId);
}
