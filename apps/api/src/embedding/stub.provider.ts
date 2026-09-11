import type { EmbeddingProvider } from './embedding.provider.js';

/**
 * Deterministic hash-based pseudo-embeddings. Zero external dependencies —
 * lets the full ingest/search pipeline run e2e (EMBEDDINGS_PROVIDER=stub).
 * Same text always yields the same vector, so search is self-consistent.
 *
 * This is a hashed bag of words with no IDF: it can only match literal token
 * overlap, never meaning, and `dimension` buckets collide heavily on a real
 * vocabulary. It is a pipeline fixture, not a relevance baseline — measure
 * retrieval quality against `openai-compatible`, never against this.
 */
export class DeterministicStubProvider implements EmbeddingProvider {
  constructor(readonly dimension: number) {}

  embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimension).fill(0);
    // Token-level hashing so shared words produce nearby vectors. The class
    // split must be Unicode-aware: `\W` is ASCII-only, so it treats every
    // Cyrillic (or CJK, Greek, Arabic…) character as a separator, which
    // tokenizes non-Latin text to nothing and embeds it as an all-zero
    // vector — unretrievable, and scoring 0 against every query.
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dimension;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return Promise.resolve(vec.map((v) => v / norm));
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
