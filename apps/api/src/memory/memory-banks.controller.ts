import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Put, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { CurrentPrincipal, Public, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CachePolicy } from '../common/http-cache.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { BankBodyDto, ListBanksQueryDto, UpdateDispositionDto } from './memory.dto.js';
import { HINDSIGHT_API_VERSION, type BankListResponse, type BankProfileResponse, type DeleteResponse, type VersionResponse } from './memory-wire.js';

/**
 * Banks in Hindsight's wire shape (#986 phase 0). `default` is Hindsight's
 * tenant segment; here it means the workspace the caller's key is pinned to.
 *
 * No `@Access`: that needs a uuid path parameter, and a bank id is free text.
 * Each handler asks `MemoryAccessService.caller` instead, which runs the same
 * `requireRole` — hence `@ReadKeyOk`, or the guard would refuse a `capture`
 * key's POST before the resolver could decide. Left out of the OpenAPI
 * document: these are Hindsight's routes, not this API's.
 */
@ApiExcludeController()
@CachePolicy('no-store')
@ReadKeyOk()
@Controller('v1/default/banks')
export class MemoryBanksController {
  constructor(
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
  ) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Query() query: ListBanksQueryDto): Promise<BankListResponse> {
    return this.banks.list(await this.access.caller(principal, ws, 'viewer'), query);
  }

  @Put(':bankId')
  @HttpCode(200)
  async put(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: BankBodyDto): Promise<BankProfileResponse> {
    return this.banks.put(await this.access.caller(principal, ws, 'editor'), bankId, dto);
  }

  @Patch(':bankId')
  async patch(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: BankBodyDto): Promise<BankProfileResponse> {
    return this.banks.patch(await this.access.caller(principal, ws, 'editor'), bankId, dto);
  }

  @Delete(':bankId')
  async delete(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string): Promise<DeleteResponse> {
    return this.banks.delete(await this.access.caller(principal, ws, 'editor'), bankId);
  }

  @Get(':bankId/profile')
  async profile(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string): Promise<BankProfileResponse> {
    return this.banks.profile(await this.access.caller(principal, ws, 'viewer'), bankId);
  }

  @Put(':bankId/profile')
  @HttpCode(200)
  async setDisposition(@CurrentPrincipal() principal: Principal, @Headers('x-workspace-id') ws: string | undefined, @Param('bankId') bankId: string, @Body() dto: UpdateDispositionDto): Promise<BankProfileResponse> {
    return this.banks.setDisposition(await this.access.caller(principal, ws, 'editor'), bankId, dto.disposition);
  }
}

/**
 * The two probes a Hindsight client sends before anything else. Public like
 * Hindsight's own, and 404 with the rest while `MEMORY_ENABLED` is off, so a
 * server without memory answers exactly as it did before these existed.
 */
@ApiExcludeController()
@CachePolicy('no-store')
@Public()
@Controller()
export class MemoryProbeController {
  constructor(private readonly access: MemoryAccessService) {}

  @Get('version')
  version(): VersionResponse {
    this.access.requireEnabled();
    return {
      api_version: HINDSIGHT_API_VERSION,
      features: {
        observations: false,
        mcp: true,
        worker: true,
        bank_config_api: false,
        bank_llm_health: false,
        file_upload_api: false,
        document_export_api: false,
        document_import_api: false,
        audit_log: false,
        llm_trace: false,
        store_document_text: true,
      },
    };
  }

  @Get('health')
  async health(): Promise<{ status: string; database: string }> {
    this.access.requireEnabled();
    await this.access.ping();
    return { status: 'healthy', database: 'connected' };
  }
}
