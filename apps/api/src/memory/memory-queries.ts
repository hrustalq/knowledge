import { BadRequestException } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import type { RecallQuery } from './memory-recall.service.js';
import type { ReflectQuery } from './memory-reflect.service.js';
import type { RecallDto, ReflectDto } from './memory.dto.js';

/**
 * Hindsight's request fields as the services read them (#986). One reading
 * for both surfaces: the REST routes pass their validated bodies, the per-bank
 * MCP tools their arguments, which carry the same names.
 */

/** `include.source_facts`' budgets, as Hindsight defaults them: 4096 tokens in all, none per observation; -1 is unlimited. */
function sourceFactsBudget(options: Record<string, unknown>): { maxTokens: number; perObservation: number } {
  const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= -1 ? v : fallback);
  return { maxTokens: int(options.max_tokens, 4096), perObservation: int(options.max_tokens_per_observation, -1) };
}

/** A recall request as the service reads it. */
export function recallQuery(dto: RecallDto, userId: string): RecallQuery {
  const window = dto.temporal_window ? { start: new Date(dto.temporal_window.start), end: new Date(dto.temporal_window.end) } : undefined;
  if (window && window.start > window.end) throw new BadRequestException(t('error.memory.windowInvalid'));
  return {
    query: dto.query,
    types: dto.types ?? undefined,
    tags: dto.tags ?? undefined,
    tagsMatch: dto.tags_match ?? undefined,
    budget: dto.budget ?? undefined,
    maxTokens: dto.max_tokens ?? undefined,
    window,
    minScores: dto.min_scores ?? undefined,
    prune: dto.rerank?.prune === true,
    // On by default; the client switches it off with `include.entities: null`.
    entities: dto.include?.entities !== null,
    chunks: dto.include?.chunks != null,
    sourceFacts: dto.include?.source_facts != null ? sourceFactsBudget(dto.include.source_facts) : null,
    preferObservations: dto.prefer_observations === true,
    userId,
  };
}

/** A reflect request as the service reads it. */
export function reflectQuery(dto: ReflectDto, principal: Pick<Principal, 'userId' | 'locale'>): ReflectQuery {
  return {
    query: dto.context?.trim() ? `${dto.query}\n\n${dto.context.trim()}` : dto.query,
    types: dto.fact_types ?? undefined,
    tags: dto.tags ?? undefined,
    tagsMatch: dto.tags_match ?? undefined,
    budget: dto.budget ?? undefined,
    maxTokens: dto.max_tokens ?? undefined,
    facts: dto.include?.facts != null,
    responseSchema: dto.response_schema ?? undefined,
    userId: principal.userId,
    locale: principal.locale,
  };
}
