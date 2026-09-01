import type { EmbeddingProvider } from './embedding.provider.js';

/**
 * Works against any OpenAI-compatible /embeddings endpoint: OpenAI, Ollama
 * (http://localhost:11434/v1), LM Studio, vLLM, hosted providers.
 * EMBEDDINGS_BASE_URL must include the /v1 suffix (OpenAI SDK convention).
 */
export class OpenAICompatibleProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    readonly dimension: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    return v;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Embedding request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
