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

export function embeddingSignature(config: ConfigService<Env, true>): string {
  const provider = config.get('EMBEDDINGS_PROVIDER', { infer: true });
  const model = config.get('EMBEDDINGS_MODEL', { infer: true }) || 'default';
  const dim = config.get('EMBEDDINGS_DIM', { infer: true });
  return `${provider}:${model}:${dim}`;
}
