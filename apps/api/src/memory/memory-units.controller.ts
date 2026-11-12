import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CachePolicy } from '../common/http-cache.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { MemoryOperationsService } from './memory-operations.service.js';
import { recallQuery, reflectQuery } from './memory-queries.js';
import { MemoryRecallService } from './memory-recall.service.js';
import { MemoryReflectService } from './memory-reflect.service.js';
import { MemoryUnitsService } from './memory-units.service.js';
import { ClearMemoriesQueryDto, ListMemoriesQueryDto, ListOperationsQueryDto, RecallDto, ReflectDto, RetainDto } from './memory.dto.js';
import type { BankStatsResponse, CancelOperationResponse, DeleteResponse, ListMemoryUnitsResponse, OperationStatusResponse, OperationsListResponse, RecallResponse, ReflectResponse, RetainResponse } from './memory-wire.js';

/**
 * What a bank holds, in Hindsight's wire shape (#986 phases 1–4): retain
 * (sync and async), recall, reflect, list, get, clear, stats, operations. Resolved per handler by `MemoryAccessService`, as the
 * bank routes are.
 */
@ApiExcludeController()
@CachePolicy('no-store')
@ReadKeyOk()
@Controller('v1/default/banks/:bankId')
export class MemoryUnitsController {
  constructor(
    private readonly access: MemoryAccessService,
    private readonly intake: MemoryIntakeService,
    private readonly units: MemoryUnitsService,
    private readonly recaller: MemoryRecallService,
    private readonly operations: MemoryOperationsService,
    private readonly reflector: MemoryReflectService,
  ) {}

  /**
   * Retain. An editor's call, and the one a `capture` key is lifted for. The
   * bank is created on a first retain. Sync: every item is stored before this
   * answers. `async: true`: the items are stored masked in an operation row,
   * the worker retains them, and this answers at once with the operation's id.
   */
  @Post('memories')
  @HttpCode(200)
  async retain(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: RetainDto): Promise<RetainResponse> {
    return this.intake.retain(await this.access.caller(principal, ws, 'editor', { capture: true }), bankId, dto);
  }

  /** Recall. A viewer's call; the bank is resolved — and a missing or hidden one refused — before anything is embedded. */
  @Post('memories/recall')
  @HttpCode(200)
  async recall(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: RecallDto): Promise<RecallResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    const bank = await this.access.bank(caller, bankId);
    return this.recaller.recall(bank, recallQuery(dto, principal.userId));
  }

  /** Reflect: one answer over what a recall returns. A viewer's call, like the recall it starts with. */
  @Post('reflect')
  @HttpCode(200)
  async reflect(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: ReflectDto): Promise<ReflectResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    const bank = await this.access.bank(caller, bankId);
    return this.reflector.reflect(bank, reflectQuery(dto, principal));
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
    const bank = await this.access.bank(caller, bankId);
    const [stats, operations] = await Promise.all([this.units.stats(bank), this.operations.counts(bank.id)]);
    return { ...stats, pending_operations: operations.pending, failed_operations: operations.failed };
  }

  @Get('operations')
  async listOperations(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Query() query: ListOperationsQueryDto): Promise<OperationsListResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.operations.list(await this.access.bank(caller, bankId), query);
  }

  @Get('operations/:operationId')
  async operationStatus(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Param('operationId') operationId: string): Promise<OperationStatusResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.operations.status(await this.access.bank(caller, bankId), operationId);
  }

  /** Cancel a pending operation. A write key's call: a `capture` key retains and nothing more. */
  @Delete('operations/:operationId')
  async cancelOperation(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Param('operationId') operationId: string): Promise<CancelOperationResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.operations.cancel(await this.access.bank(caller, bankId), operationId);
  }
}
