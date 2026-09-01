import type { InferredFact, RelationExtractor } from './relation-extractor.provider.js';

/** Default extractor: inference disabled, zero external dependencies. */
export class NoopExtractor implements RelationExtractor {
  readonly enabled = false;

  extract(): Promise<InferredFact[]> {
    return Promise.resolve([]);
  }
}
