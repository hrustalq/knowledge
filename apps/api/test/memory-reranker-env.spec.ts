import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env.js';

/** #1158: the reranker's env block — an empty base URL is "not configured", anything else must be a URL; scores default to logits. */
describe('MEMORY_RERANKER_* env', () => {
  const shape = envSchema.pick({ MEMORY_RERANKER_BASE_URL: true, MEMORY_RERANKER_SCORE: true });

  it('defaults to no base URL and logit scores', () => {
    expect(shape.parse({})).toEqual({ MEMORY_RERANKER_BASE_URL: '', MEMORY_RERANKER_SCORE: 'logit' });
    expect(shape.parse({ MEMORY_RERANKER_BASE_URL: '' }).MEMORY_RERANKER_BASE_URL).toBe('');
  });

  it('accepts a URL and normalized scores, and refuses a base URL that is not a URL', () => {
    expect(shape.parse({ MEMORY_RERANKER_BASE_URL: 'http://litellm:4000/v1', MEMORY_RERANKER_SCORE: 'normalized' })).toEqual({ MEMORY_RERANKER_BASE_URL: 'http://litellm:4000/v1', MEMORY_RERANKER_SCORE: 'normalized' });
    expect(shape.safeParse({ MEMORY_RERANKER_BASE_URL: 'not a url' }).success).toBe(false);
    expect(shape.safeParse({ MEMORY_RERANKER_SCORE: 'sigmoid' }).success).toBe(false);
  });
});
