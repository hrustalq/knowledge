export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingProvider {
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// Phase 5 stale detection (plan.md §11): identity of the embedding space a
// revision was indexed under. A change in provider, model or dimension makes
// previously indexed revisions "drifted" and schedules their reindex.
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/**
 * Bump when the *text we embed* changes shape, not just the model behind it.
 * The embedding space is defined by both halves, so a recipe change strands
 * already-indexed revisions in an incomparable space exactly as a model swap
 * does — and this is the only signal the stale sweeper has to reindex them.
 *
 * r2: chunks embed as title + heading breadcrumb + body (`chunkEmbedText`),
 *     and the stub tokenizer became Unicode-aware.
 */
const EMBED_RECIPE = 'r2';

export function embeddingSignature(config: ConfigService<Env, true>): string {
  const provider = config.get('EMBEDDINGS_PROVIDER', { infer: true });
  const model = config.get('EMBEDDINGS_MODEL', { infer: true }) || 'default';
  const dim = config.get('EMBEDDINGS_DIM', { infer: true });
  return `${provider}:${model}:${dim}:${EMBED_RECIPE}`;
}
