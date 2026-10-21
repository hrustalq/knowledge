import type { SourceVerificationState, TrustWeights } from '@knowledge/contracts';
import { trustWeight } from '@knowledge/contracts';
import type { ChunkHit } from '../graph/graph.service.js';

/** The knobs a workspace may override and `make tune` proposes (#305, #401). */
export interface SearchKnobs {
  rrfK: number;
  minCosine: number;
  minCosineShare: number;
  trustWeights: TrustWeights;
}

/**
 * The relevance floor (#401): the vector hits worth fusing — cosine at least
 * `minCosine` and at least `minCosineShare` of the leg's best. Applied before
 * fusion, so a chunk weak in both legs is gone and one weak in one leg keeps
 * only the other's rank; a search may then return fewer than its limit. The
 * BM25 leg needs no floor: its match already demands most of the query's
 * terms (#400). Hits arrive best first, so the first is the leg's best.
 */
export function floorVectorHits<T extends Pick<ChunkHit, 'score'>>(hits: T[], knobs: Pick<SearchKnobs, 'minCosine' | 'minCosineShare'>): T[] {
  const min = Math.max(knobs.minCosine, knobs.minCosineShare * (hits[0]?.score ?? 0));
  return hits.filter((h) => h.score >= min);
}

/**
 * Merge vector and BM25 rankings. Single-source results keep their native
 * score (BM25 normalized to 0..1 by the max); two-source results use
 * reciprocal rank fusion — raw cosine and BM25 scores are not comparable.
 */
export function fuseHits<T extends Pick<ChunkHit, 'chunkId' | 'score'>>(vectorHits: T[], textHits: T[], k: number, rrfK: number): T[] {
  if (textHits.length === 0) return vectorHits.slice(0, k);
  if (vectorHits.length === 0) {
    const max = Math.max(...textHits.map((h) => h.score), 1e-9);
    return textHits.slice(0, k).map((h) => ({ ...h, score: h.score / max }));
  }
  const fused = new Map<string, T>();
  const add = (rank: number, hit: T) => {
    const existing = fused.get(hit.chunkId);
    const increment = 1 / (rrfK + rank + 1);
    if (existing) existing.score += increment;
    else fused.set(hit.chunkId, { ...hit, score: increment });
  };
  vectorHits.forEach((h, i) => add(i, h));
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
}

/**
 * `SearchService.search` with no filters, from the fusion on: the ranked page
 * ids, one per hit. Kept step for step with the service — the parity case in
 * `search-trust.spec.ts` replays one search through both.
 */
export function rankPool(pool: SearchPool, knobs: SearchKnobs): string[] {
  const weighted = fuseHits(floorVectorHits(pool.vectorHits, knobs), pool.textHits, pool.fetchK, knobs.rrfK).flatMap((h) => {
    const page = pool.pages.get(h.documentId);
    if (!page || page.archived) return [];
    const weight = pool.trustOn ? trustWeight(page.status, page.inactive, knobs.trustWeights) : 1;
    return [{ documentId: h.documentId, score: h.score * weight }];
  });
  if (pool.trustOn) weighted.sort((a, b) => b.score - a.score);
  return weighted.slice(0, pool.k).map((w) => w.documentId);
}
