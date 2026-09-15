import { Logger } from '@nestjs/common';
import { AUTHORABLE_RELATION_TYPES } from '@knowledge/contracts';
import type {
  ExtractionBilling,
  ExtractionChunk,
  ExtractionTuning,
  InferredFact,
  RelationExtractor,
} from './relation-extractor.provider.js';
import { AiUsageService, estimateTokens, type AiUsageTokens } from '../ai/ai-usage.service.js';

/**
 * Relation extraction via any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, Ollama, LM Studio, vLLM…). One request per chunk, JSON output.
 * TAGGED_WITH is deliberately excluded — tags stay deterministic (frontmatter).
 *
 * Calls are made here rather than through AssistantClient, and billed here for
 * the same reason the OCR parser is: that client appends the locale directive
 * to every prompt (docs/features/18), and this prompt must stay unlocalized so
 * its graph keys are identical whatever language the page is in. It also pins
 * temperature 0, which AssistantClient cannot express.
 */
/** Exactly what a person may write by hand: inference must not invent an edge
 *  type the frontmatter parser would reject, or the two classes disagree about
 *  what the vocabulary is. TAGGED_WITH stays deterministic, as above. */
const INFERABLE_TYPES = AUTHORABLE_RELATION_TYPES;

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

/** OpenAI-shaped usage block; several compatible servers omit it entirely. */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export class OpenAICompatibleExtractor implements RelationExtractor {
  readonly enabled = true;
  private readonly logger = new Logger(OpenAICompatibleExtractor.name);

  // Only connection identity lives on the instance. Tuning and the billing
  // identity arrive per call (docs/features/12) because ExtractorFactory caches
  // these by endpoint and credential, so a value baked in here would outlive
  // the workspace it came from. AiUsageService is the exception: it is a
  // process-wide singleton with no per-workspace state.
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    private readonly usage: AiUsageService,
  ) {}

  async extract(
    input: { documentTitle: string; chunks: ExtractionChunk[] } & ExtractionTuning & ExtractionBilling,
  ): Promise<InferredFact[]> {
    const facts = new Map<string, InferredFact>();
    for (const chunk of input.chunks.slice(0, input.maxChunks)) {
      for (const fact of await this.extractChunk(input.documentTitle, chunk, input.minConfidence, input)) {
        const id = `${fact.type} ${fact.target.key}`;
        const existing = facts.get(id);
        if (!existing || fact.confidence > existing.confidence) facts.set(id, fact);
      }
    }
    return [...facts.values()];
  }

  /**
   * Records one upstream call. Fire-and-forget, exactly like
   * AssistantClient.bill and ActivityService.record: token accounting is
   * observability, and a failed insert must never fail an indexing job.
   */
  private bill(
    billing: ExtractionBilling,
    tokens: AiUsageTokens,
    startedAt: number,
    outcome: { ok: boolean; error?: string },
  ): void {
    void this.usage
      .record({
        config: billing.config,
        userId: billing.userId,
        operation: 'extraction',
        tokens,
        durationMs: Date.now() - startedAt,
        ok: outcome.ok,
        error: outcome.error,
      })
      .catch((e: unknown) => this.logger.warn(`Usage not recorded: ${(e as Error).message}`));
  }

  private async extractChunk(
    title: string,
    chunk: ExtractionChunk,
    minConfidence: number,
    billing: ExtractionBilling,
  ): Promise<InferredFact[]> {
    const prompt = `Document: ${title}\nSection: ${chunk.headingPath.join(' > ') || '(root)'}\n\n${chunk.text}`;
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (err) {
      // Unreachable endpoint: nothing was spent upstream, but the attempt is
      // still recorded so a misconfigured provider is visible in the log
      // rather than only in worker output nobody reads.
      this.bill(billing, zeroTokens(), startedAt, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      this.bill(billing, zeroTokens(), startedAt, { ok: false, error: `HTTP ${res.status}: ${body}` });
      throw new Error(`Extraction request failed (${res.status}): ${body}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: RawUsage;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    this.bill(billing, tokensFrom(json.usage, prompt, content), startedAt, { ok: true });

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

function zeroTokens(): AiUsageTokens {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true };
}

/**
 * Provider-reported usage when there is one, a local estimate otherwise — the
 * same fallback AssistantClient makes, flagged `estimated` so nobody reads it
 * as billing truth.
 */
function tokensFrom(usage: RawUsage | undefined, prompt: string, completion: string): AiUsageTokens {
  if (usage) {
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
      estimated: false,
    };
  }
  const promptTokens = estimateTokens(`${SYSTEM_PROMPT}\n${prompt}`);
  const completionTokens = estimateTokens(completion);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}
