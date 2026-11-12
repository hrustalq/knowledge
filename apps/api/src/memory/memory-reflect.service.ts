import { BadGatewayException, ConflictException, Injectable, Logger } from '@nestjs/common';
import type { MemoryBank } from '@prisma/client';
import type { Locale } from '@knowledge/contracts';
import { z } from 'zod';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { parseModelJson } from '../common/model-json.js';
import { passageMessages } from '../common/passage-prompt.js';
import { t } from '../i18n/t.js';
import { MemoryRecallService, type RecallQuery } from './memory-recall.service.js';
import { DEFAULT_DISPOSITION, type Disposition, type RecallResult, type ReflectResponse } from './memory-wire.js';

export interface ReflectQuery extends Pick<RecallQuery, 'query' | 'types' | 'tags' | 'tagsMatch' | 'budget' | 'maxTokens' | 'userId'> {
  locale: Locale;
  /** `include.facts`: list the memories the answer was written from. */
  facts?: boolean;
  /** A JSON Schema the answer must also be given in. */
  responseSchema?: Record<string, unknown>;
}

const TRAIT = {
  skepticism: ['Take what the memories say on trust.', '', 'Treat a memory as a claim, not a fact: say when one is thin or contradicted.'],
  literalism: ['Read the memories for what they mean, not only what they say.', '', 'Read the memories literally and infer nothing they do not state.'],
  empathy: ['Stay matter-of-fact.', '', 'Take into account how the people in the memories felt.'],
} as const;

/** The bank's mission and disposition as trusted lines for the system prompt. A trait at its midpoint says nothing. */
export function bankBrief(bank: Pick<MemoryBank, 'mission' | 'disposition'>): string {
  const disposition = { ...DEFAULT_DISPOSITION, ...(bank.disposition as Partial<Disposition>) };
  const traits = (Object.keys(TRAIT) as Array<keyof typeof TRAIT>).map((k) => TRAIT[k][disposition[k] <= 2 ? 0 : disposition[k] >= 4 ? 2 : 1]).filter(Boolean);
  return [bank.mission.trim() ? `What this memory is for: ${bank.mission.trim()}` : '', ...traits].filter(Boolean).join('\n');
}

const STRUCTURED_CONTRACT =
  'Respond ONLY with a json object {"text": string, "structured_output": object}. text is your answer in markdown. ' +
  'structured_output is the same answer as an object that satisfies this JSON Schema:\n';

/**
 * The model's reply when a `response_schema` was asked for: the answer text,
 * and the structured output or the reason there is none. Never throws — an
 * unusable reply still yields its text.
 */
export function readStructured(content: string, schema: Record<string, unknown>): Pick<ReflectResponse, 'text' | 'structured_output' | 'structured_output_error'> {
  const parsed = parseModelJson<{ text?: unknown; structured_output?: unknown }>(content);
  if (!parsed) return { text: content, structured_output: null, structured_output_error: 'The model did not answer with a JSON object.' };
  const text = typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text : content;
  const output = parsed.structured_output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { text, structured_output: null, structured_output_error: 'The model answered without a structured_output object.' };
  }
  let check: z.ZodType;
  try {
    check = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // A schema this server cannot read is the client's to check: the object is passed on as the model gave it.
    return { text, structured_output: output as Record<string, unknown> };
  }
  const result = check.safeParse(output);
  return result.success
    ? { text, structured_output: output as Record<string, unknown> }
    : { text, structured_output: null, structured_output_error: `The model's output does not match the schema: ${z.prettifyError(result.error).slice(0, 500)}` };
}

const fact = (r: RecallResult) => ({
  id: r.id,
  text: r.text,
  type: r.type,
  context: r.context,
  occurred_start: r.occurred_start,
  occurred_end: r.occurred_end,
  mentioned_at: r.mentioned_at,
  document_id: r.document_id,
  chunk_id: null,
  tags: r.tags,
  metadata: r.metadata,
});

/**
 * Reflect (#986 phase 4): one recall, then one model call over what it
 * returned. Never the stores directly — the recall service decides what the
 * bank holds for the question, and this only writes the answer.
 *
 * Trust: the agent's instructions, the bank's mission and its disposition are
 * the system prompt. The memories are an agent's own notes from sources nobody
 * reviewed, so they reach the model only inside the untrusted wrapper, in the
 * user turn; a memory that says "ignore your instructions" changes no rule.
 *
 * No model, no answer: with none configured, or the reflector switched off,
 * this refuses before anything is recalled or billed. A spent budget refuses
 * the same way (`assertWithinBudget`).
 */
@Injectable()
export class MemoryReflectService {
  private readonly logger = new Logger(MemoryReflectService.name);

  constructor(
    private readonly recall: MemoryRecallService,
    private readonly agents: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly client: AssistantClient,
  ) {}

  async reflect(bank: MemoryBank, q: ReflectQuery): Promise<ReflectResponse> {
    const agent = await this.agents.resolve(bank.workspaceId, 'reflector');
    if (!agent.enabled || !agent.config.enabled) throw new ConflictException(t('error.memory.noReflectModel'));
    await this.usage.assertWithinBudget(bank.workspaceId, q.userId);

    const { text: memories, results } = await this.recall.recallForModel(
      bank,
      { query: q.query, types: q.types, tags: q.tags, tagsMatch: q.tagsMatch, budget: q.budget, maxTokens: q.maxTokens, userId: q.userId },
      'reflect',
    );
    const system = [agent.instructions, bankBrief(bank), q.responseSchema ? STRUCTURED_CONTRACT + JSON.stringify(q.responseSchema) : ''].filter(Boolean).join('\n\n');
    const { content, tokens } = await this.client
      .chatWithUsage({ config: agent.config, userId: q.userId, operation: 'memory-reflect', locale: q.locale }, passageMessages(system, memories, q.query), { json: Boolean(q.responseSchema) })
      .catch((err: unknown) => {
        // The provider's own wording (credit, keys, quotas) is for the workspace's admins, in AI usage.
        this.logger.warn({ msg: 'memory reflect: model call failed', workspaceId: bank.workspaceId, err });
        throw new BadGatewayException(t('error.memory.reflectFailed'));
      });
    return {
      ...(q.responseSchema ? readStructured(content, q.responseSchema) : { text: content }),
      usage: { input_tokens: tokens.promptTokens, output_tokens: tokens.completionTokens, total_tokens: tokens.totalTokens },
      // Only what the recall handed the model: an id here is a memory of this bank it was shown.
      ...(q.facts ? { based_on: { memories: results.map(fact), mental_models: [], directives: [] } } : {}),
    };
  }
}
