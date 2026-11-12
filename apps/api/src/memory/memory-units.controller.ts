import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CachePolicy } from '../common/http-cache.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { readRetainItems } from './memory-facts.js';
import { MemoryRecallService, type RecallQuery } from './memory-recall.service.js';
import { MemoryRetainService } from './memory-retain.service.js';
import { MemoryUnitsService } from './memory-units.service.js';
import { ClearMemoriesQueryDto, ListMemoriesQueryDto, RecallDto, RetainDto } from './memory.dto.js';
import type { BankStatsResponse, DeleteResponse, ListMemoryUnitsResponse, RecallResponse, RetainResponse } from './memory-wire.js';

/** A recall body as the service reads it. Shared with the per-bank MCP tools, which take the same fields. */
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
    sourceFacts: dto.include?.source_facts != null,
    userId,
  };
}

/**
 * What a bank holds, in Hindsight's wire shape (#986 phases 1–2): retain,
 * recall, list, get, clear, stats. Resolved per handler by `MemoryAccessService`, as the
 * bank routes are.
 */
@ApiExcludeController()
@CachePolicy('no-store')
@ReadKeyOk()
@Controller('v1/default/banks/:bankId')
export class MemoryUnitsController {
  private readonly limits: { maxItems: number; maxChars: number };
  private readonly ratePerMin: number;

  constructor(
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
    private readonly retainer: MemoryRetainService,
    private readonly units: MemoryUnitsService,
    private readonly recaller: MemoryRecallService,
    private readonly limiter: PublicRateLimiter,
    config: ConfigService<Env, true>,
  ) {
    this.limits = { maxItems: config.get('MEMORY_RETAIN_MAX_ITEMS', { infer: true }), maxChars: config.get('MEMORY_RETAIN_MAX_CHARS', { infer: true }) };
    this.ratePerMin = config.get('MEMORY_RETAIN_RATE_PER_MIN', { infer: true });
  }

  /**
   * Retain. An editor's call, and the one a `capture` key is lifted for. The
   * bank is created on a first retain. Sync: every item is stored before this
   * answers.
   */
  @Post('memories')
  @HttpCode(200)
  async retain(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: RetainDto): Promise<RetainResponse> {
    const caller = await this.access.caller(principal, ws, 'editor', { capture: true });
    // Per key, or per person without one. Fail-open: a Redis outage must not stop an agent remembering.
    if (!(await this.limiter.hit(`memory:retain:${principal.apiKey?.id ?? principal.userId}`, this.ratePerMin, 60_000, true))) {
      throw new RateLimitedException(t('error.memory.rateLimited'), 60);
    }
    const items = readRetainItems(dto.items, dto.document_tags, this.limits);
    const bank = await this.banks.ensure(caller, bankId);
    const { usage } = await this.retainer.retain({ workspaceId: caller.workspaceId, bank, userId: principal.userId, locale: principal.locale, items });
    return { success: true, bank_id: bank.bankId, items_count: items.length, async: false, ...(usage ? { usage } : {}) };
  }

  /** Recall. A viewer's call; the bank is resolved — and a missing or hidden one refused — before anything is embedded. */
  @Post('memories/recall')
  @HttpCode(200)
  async recall(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: RecallDto): Promise<RecallResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    const bank = await this.access.bank(caller, bankId);
    return this.recaller.recall(bank, recallQuery(dto, principal.userId));
  }

  @Get('memories/list')
  async list(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Query() query: ListMemoriesQueryDto): Promise<ListMemoryUnitsResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.list(await this.access.bank(caller, bankId), query);
  }

  @Get('memories/:memoryId')
  async get(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Param('memoryId') memoryId: string) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.get(await this.access.bank(caller, bankId), memoryId);
  }

  @Delete('memories')
  async clear(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Query() query: ClearMemoriesQueryDto): Promise<DeleteResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.units.clear(await this.access.bank(caller, bankId), query.type);
  }

  @Get('stats')
  async stats(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string): Promise<BankStatsResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.stats(await this.access.bank(caller, bankId));
  }
}
