import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MemoryBank } from '@prisma/client';
import type { Env } from '../config/env.js';
import type { MemoryCaller } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { assertRetainCeilings, readRetainItems, type RetainItem } from './memory-facts.js';
import { MemoryOperationsService } from './memory-operations.service.js';
import { MemoryRateService } from './memory-rate.service.js';
import { MemoryRetainService, type RetainInput } from './memory-retain.service.js';
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
 * API-only: the rate limiter is the API's (`MemoryRateService`), and the worker never takes a
 * request — it runs `MemoryRetainService` on an operation's row.
 */
@Injectable()
export class MemoryIntakeService {
  private readonly limits: { maxItems: number; maxChars: number };

  constructor(
    private readonly banks: MemoryBanksService,
    private readonly retainer: MemoryRetainService,
    private readonly operations: MemoryOperationsService,
    private readonly rate: MemoryRateService,
    config: ConfigService<Env, true>,
  ) {
    this.limits = { maxItems: config.get('MEMORY_RETAIN_MAX_ITEMS', { infer: true }), maxChars: config.get('MEMORY_RETAIN_MAX_CHARS', { infer: true }) };
  }

  /** `caller` must have been resolved as an editor (`{ capture: true }`): this checks no role of its own. */
  async retain(caller: MemoryCaller, bankId: string, request: RetainRequest): Promise<RetainResponse> {
    const { principal } = caller;
    await this.rate.check('retain', principal);
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

  /**
   * The door for a wire that builds its own items (#1007): the graph and file
   * wires. Same rate, ceilings and bank creation as `retain`; always sync, as
   * those wires answer from what they just wrote. Same role contract as `retain`.
   */
  async retainItems(caller: MemoryCaller, bankId: string, items: RetainItem[], options: Pick<RetainInput, 'verbatim' | 'consolidated'> = {}): Promise<{ bank: MemoryBank; units: number }> {
    const { principal } = caller;
    await this.rate.check('retain', principal);
    assertRetainCeilings(items, this.limits);
    const bank = await this.banks.ensure(caller, bankId);
    const { units } = await this.retainer.retain({ workspaceId: caller.workspaceId, bank, userId: principal.userId, locale: principal.locale, items, ...options });
    return { bank, units };
  }
}
