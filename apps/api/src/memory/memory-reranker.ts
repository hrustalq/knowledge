import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

export const MEMORY_RERANKER_PROVIDER = Symbol('MEMORY_RERANKER_PROVIDER');

export interface MemoryRerankerProvider {
  readonly candidateCap: number;
  rerank(query: string, documents: string[]): Promise<number[]>;
}

const MAX_QUERY_CHARS = 4000;
const MAX_DOCUMENT_CHARS = 12_000;
const MAX_TOTAL_DOCUMENT_CHARS = 200_000;

/** An operator-configured `/rerank` endpoint, fetched plainly like EMBEDDING_*. Scores are model logits, normalized with a sigmoid. */
export class OpenAICompatibleMemoryReranker implements MemoryRerankerProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    readonly candidateCap: number,
  ) {}

  async rerank(query: string, documents: string[]): Promise<number[]> {
    const selected = documents.slice(0, this.candidateCap);
    if (!selected.length) return [];
    const documentCap = Math.min(
      MAX_DOCUMENT_CHARS,
      Math.floor(MAX_TOTAL_DOCUMENT_CHARS / selected.length),
    );
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/rerank`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        query: query.slice(0, MAX_QUERY_CHARS),
        documents: selected.map((text) => text.slice(0, documentCap)),
        top_n: selected.length,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok)
      throw new Error(
        `Memory reranker request failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    const body = (await res.json()) as {
      results?: Array<{ index?: unknown; relevance_score?: unknown }>;
    };
    if (!Array.isArray(body.results))
      throw new Error('Memory reranker returned no results');
    const scores: Array<number | undefined> = Array.from({
      length: selected.length,
    });
    for (const result of body.results) {
      if (
        !Number.isInteger(result.index) ||
        Number(result.index) < 0 ||
        Number(result.index) >= selected.length ||
        scores[Number(result.index)] !== undefined ||
        typeof result.relevance_score !== 'number' ||
        !Number.isFinite(result.relevance_score)
      ) {
        throw new Error('Memory reranker returned an invalid result');
      }
      scores[Number(result.index)] =
        1 / (1 + Math.exp(-result.relevance_score));
    }
    return selected.map((_, index) => {
      const score = scores[index];
      if (score === undefined)
        throw new Error('Memory reranker omitted a candidate');
      return score;
    });
  }
}

export function createMemoryReranker(
  config: ConfigService<Env, true>,
): MemoryRerankerProvider | null {
  if (config.get('MEMORY_RERANKER_PROVIDER', { infer: true }) === 'none')
    return null;
  const baseUrl = config.get('MEMORY_RERANKER_BASE_URL', { infer: true });
  const model = config.get('MEMORY_RERANKER_MODEL', { infer: true });
  if (!baseUrl || !model)
    throw new Error(
      'MEMORY_RERANKER_BASE_URL and MEMORY_RERANKER_MODEL are required when the memory reranker is enabled',
    );
  return new OpenAICompatibleMemoryReranker(
    baseUrl,
    model,
    config.get('MEMORY_RERANKER_API_KEY', { infer: true }),
    config.get('MEMORY_RERANKER_TIMEOUT_MS', { infer: true }),
    config.get('MEMORY_RERANKER_CANDIDATE_CAP', { infer: true }),
  );
}
