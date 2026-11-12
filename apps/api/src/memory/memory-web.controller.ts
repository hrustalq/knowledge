import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CaptureResult, MemoryBankListResponse, MemoryBankSummary, MemoryUnitListResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { MemoryWebService } from './memory-web.service.js';
import { BindMemoryBankDto, DeleteMemoryBankQueryDto, MemoryBanksQueryDto, MemoryUnitsQueryDto, PromoteMemoryDto } from './memory-web.dto.js';

/**
 * Memory banks for this platform's web app (#994, docs/features/80): the
 * settings section and a bank's page. `:id` is the bank's row id, resolved to
 * its workspace in PG first (source `memory-bank`); the bank's project rule is
 * `MemoryWebService`'s, a 404. Off with the `memory` section, and with
 * `MEMORY_ENABLED`. The Hindsight-shaped routes are untouched by this.
 */
@ApiTags('memory')
@Feature('memory')
@Controller('v1/memory')
export class MemoryWebController {
  constructor(private readonly web: MemoryWebService) {}

  @Get('banks')
  @Returns('MemoryBankListResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'The memory banks of a workspace the caller may read, with their size and how to connect a client' })
  list(@Query() query: MemoryBanksQueryDto, @CurrentPrincipal() principal: Principal): Promise<MemoryBankListResponse> {
    return this.web.list(principal, query.workspaceId);
  }

  @Get('banks/:id/memories')
  @Returns('MemoryUnitListResponse')
  @Access('viewer', 'memory-bank')
  @ApiOperation({ summary: 'A memory bank\'s facts and observations, newest first' })
  units(@Param('id', ParseUUIDPipe) id: string, @Query() query: MemoryUnitsQueryDto, @CurrentPrincipal() principal: Principal): Promise<MemoryUnitListResponse> {
    return this.web.memories(principal, id, query);
  }

  @Patch('banks/:id')
  @Returns('MemoryBankSummary')
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Bind a memory bank to a project (it then follows that project\'s restriction), or to the whole workspace. Needs manage on both projects' })
  bind(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BindMemoryBankDto, @CurrentPrincipal() principal: Principal): Promise<MemoryBankSummary> {
    return this.web.bind(principal, id, dto.projectId);
  }

  @Delete('banks/:id')
  @HttpCode(204)
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Delete a memory bank and everything it holds; `confirm` must be its bank id' })
  async deleteBank(@Param('id', ParseUUIDPipe) id: string, @Query() query: DeleteMemoryBankQueryDto, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.web.deleteBank(principal, id, query.confirm);
  }

  @Delete('banks/:id/memories/:memoryId')
  @HttpCode(204)
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Delete one memory. A fact leaves the observations it supported; one left with no evidence goes too' })
  async deleteUnit(@Param('id', ParseUUIDPipe) id: string, @Param('memoryId', ParseUUIDPipe) memoryId: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.web.deleteUnit(principal, id, memoryId);
  }

  @Post('banks/:id/memories/:memoryId/promote')
  @Returns('CaptureResult')
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Propose a memory as a page: a capture, and so a merge request someone reviews. The memory stays in the bank' })
  promote(@Param('id', ParseUUIDPipe) id: string, @Param('memoryId', ParseUUIDPipe) memoryId: string, @Body() dto: PromoteMemoryDto, @CurrentPrincipal() principal: Principal): Promise<CaptureResult> {
    return this.web.promote(principal, id, memoryId, dto);
  }
}
