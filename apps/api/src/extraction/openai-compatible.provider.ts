import { Logger } from '@nestjs/common';
import type {
  ExtractionChunk,
  ExtractionTuning,
  InferredFact,
  RelationExtractor,
} from './relation-extractor.provider.js';

/**
 * Relation extraction via any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, Ollama, LM Studio, vLLM…). One request per chunk, JSON output.
 * TAGGED_WITH is deliberately excluded — tags stay deterministic (frontmatter).
 */
const INFERABLE_TYPES = [
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
] as const;

// Deliberately NOT localized (docs/features/18): this prompt emits stable graph
// keys like "service:identity", and those must be identical whatever language
// the page is written in. Localizing them would fragment the graph — the same
// entity extracted from an English and a Russian page would never link up.
const SYSTEM_PROMPT = `You extract relations between a documentation page and named entities (services, components, systems, teams, concepts) mentioned in it.
Return STRICT JSON: {"relations":[{"type":<one of ${INFERABLE_TYPES.join(', ')}>,"entity":{"key":"<type>:<kebab-name>","type":"<service|component|team|concept|...>","name":"<Display Name>"},"confidence":<0..1>}]}
Only include relations the text clearly supports. Use stable keys like "service:identity". Return {"relations":[]} when none.`;

interface RawRelation {
  type?: unknown;
  entity?: { key?: unknown; type?: unknown; name?: unknown };
  confidence?: unknown;
}

export class OpenAICompatibleExtractor implements RelationExtractor {
  readonly enabled = true;
  private readonly logger = new Logger(OpenAICompatibleExtractor.name);

  // Only connection identity lives on the instance. Tuning arrives per call
  // (docs/features/12) because ExtractorFactory caches these by endpoint and
  // credential, so a value baked in here would outlive the workspace it came
  // from — and the env-configured instance is shared by every workspace.
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  async extract(
    input: { documentTitle: string; chunks: ExtractionChunk[] } & ExtractionTuning,
  ): Promise<InferredFact[]> {
    const facts = new Map<string, InferredFact>();
    for (const chunk of input.chunks.slice(0, input.maxChunks)) {
      for (const fact of await this.extractChunk(input.documentTitle, chunk, input.minConfidence)) {
        const id = `${fact.type} ${fact.target.key}`;
        const existing = facts.get(id);
        if (!existing || fact.confidence > existing.confidence) facts.set(id, fact);
      }
    }
    return [...facts.values()];
  }

  private async extractChunk(
    title: string,
    chunk: ExtractionChunk,
    minConfidence: number,
  ): Promise<InferredFact[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Document: ${title}\nSection: ${chunk.headingPath.join(' > ') || '(root)'}\n\n${chunk.text}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Extraction request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? '';
    let parsed: { relations?: RawRelation[] };
    try {
      parsed = JSON.parse(content) as { relations?: RawRelation[] };
    } catch {
      this.logger.warn(`Extractor returned non-JSON for chunk ${chunk.chunkId} — skipping`);
      return [];
    }
    if (!Array.isArray(parsed.relations)) return [];

    const out: InferredFact[] = [];
    for (const rel of parsed.relations) {
      const type = typeof rel.type === 'string' ? rel.type.toUpperCase() : '';
      if (!(INFERABLE_TYPES as readonly string[]).includes(type)) continue;
      const key = typeof rel.entity?.key === 'string' ? rel.entity.key.trim() : '';
      if (!key) continue;
      // An omitted confidence means the model asserted the relation without
      // scoring it, so it is read as asserted (1). It used to default to 0,
      // which silently dropped EVERY such relation at any threshold above 0 —
      // a workspace could run extraction correctly and still get an empty graph.
      const confidence = Math.min(1, Math.max(0, Number(rel.confidence ?? 1)));
      if (confidence < minConfidence) continue;
      out.push({
        type,
        target: {
          key,
          type:
            typeof rel.entity?.type === 'string' && rel.entity.type.trim()
              ? rel.entity.type.trim()
              : key.includes(':')
                ? key.slice(0, key.indexOf(':'))
                : 'entity',
          name:
            typeof rel.entity?.name === 'string' && rel.entity.name.trim()
              ? rel.entity.name.trim()
              : (key.split(':').pop() ?? key),
        },
        confidence,
        sourceChunkId: chunk.chunkId,
        snippet: chunk.text.slice(0, 200),
      });
    }
    return out;
  }
}
