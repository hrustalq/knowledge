import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';
import type { MemoryCaller } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { readRetainItems } from './memory-facts.js';
import { MemoryOperationsService } from './memory-operations.service.js';
import { MemoryRetainService } from './memory-retain.service.js';
import type { RetainResponse } from './memory-wire.js';

export interface RetainRequest {
  items: ReadonlyArray<Record<string, unknown>>;
  document_tags?: unknown;
  async?: boolean | null;
  operation_id?: string | null;
}

/**
 * The one door a retain comes in through (#986), whichever surface it arrived
 * on — the REST route or a per-bank MCP tool: the per-key rate, the request's
 * ceilings, the bank created on a first retain, then sync or async.
 *
 * API-only: the rate limiter is the API's, and the worker never takes a
 * request — it runs `MemoryRetainService` on an operation's row.
 */
@Injectable()
export class MemoryIntakeService {
  private readonly limits: { maxItems: number; maxChars: number };
  private readonly ratePerMin: number;

  constructor(
    private readonly banks: MemoryBanksService,
    private readonly retainer: MemoryRetainService,
    private readonly operations: MemoryOperationsService,
    private readonly limiter: PublicRateLimiter,
    config: ConfigService<Env, true>,
  ) {
    this.limits = { maxItems: config.get('MEMORY_RETAIN_MAX_ITEMS', { infer: true }), maxChars: config.get('MEMORY_RETAIN_MAX_CHARS', { infer: true }) };
    this.ratePerMin = config.get('MEMORY_RETAIN_RATE_PER_MIN', { infer: true });
  }

  /** `caller` must have been resolved as an editor (`{ capture: true }`): this checks no role of its own. */
  async retain(caller: MemoryCaller, bankId: string, request: RetainRequest): Promise<RetainResponse> {
    const { principal } = caller;
    // Per key, or per person without one. Fail-open: a Redis outage must not stop an agent remembering.
    if (!(await this.limiter.hit(`memory:retain:${principal.apiKey?.id ?? principal.userId}`, this.ratePerMin, 60_000, true))) {
      throw new RateLimitedException(t('error.memory.rateLimited'), 60);
    }
    const items = readRetainItems(request.items, request.document_tags, this.limits);
    const bank = await this.banks.ensure(caller, bankId);
    const done = { success: true, bank_id: bank.bankId, items_count: items.length };
    if (request.async === true) {
      const operation_id = await this.operations.submit(bank, { items, userId: principal.userId, locale: principal.locale, operationId: request.operation_id });
      return { ...done, async: true, operation_id };
    }
    const { usage } = await this.retainer.retain({ workspaceId: caller.workspaceId, bank, userId: principal.userId, locale: principal.locale, items });
    return { ...done, async: false, ...(usage ? { usage } : {}) };
  }
}
