import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CaptureResult,
  MemoryBankListResponse,
  MemoryBankSummary,
  MemoryEntityListResponse,
  MemoryFileContent,
  MemoryFileListResponse,
  MemoryUnitListResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { MemoryWebService } from './memory-web.service.js';
import { BindMemoryBankDto, DeleteMemoryBankQueryDto, MemoryBanksQueryDto, MemoryPageQueryDto, MemoryUnitsQueryDto, PromoteMemoryDto } from './memory-web.dto.js';

/**
 * Memory banks for this platform's web app (#994, docs/features/80): the
 * settings section and a bank's page. `:id` is the bank's row id, resolved to
 * its workspace in PG first (source `memory-bank`); the bank's project rule is
 * `MemoryWebService`'s, a 404. Off with the `memory` section, and with
 * `MEMORY_ENABLED`. The Hindsight-shaped routes are untouched by this.
 *
 * The entities and files routes (#1010) show what the graph and memory-tool
 * wires wrote: read for a viewer, delete for an editor, no other write.
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

  @Get('banks/:id/entities')
  @Returns('MemoryEntityListResponse')
  @Access('viewer', 'memory-bank')
  @ApiOperation({ summary: 'A memory bank\'s graph entities (the `/mcp/<bank>/graph` wire), in creation order, with their observations and relations' })
  entities(@Param('id', ParseUUIDPipe) id: string, @Query() query: MemoryPageQueryDto, @CurrentPrincipal() principal: Principal): Promise<MemoryEntityListResponse> {
    return this.web.entities(principal, id, query);
  }

  @Delete('banks/:id/entities/:entityId')
  @HttpCode(204)
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Delete one graph entity, with its observations and every relation touching it' })
  async deleteEntity(@Param('id', ParseUUIDPipe) id: string, @Param('entityId', ParseUUIDPipe) entityId: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.web.deleteEntity(principal, id, entityId);
  }

  @Delete('banks/:id/relations/:relationId')
  @HttpCode(204)
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Delete one graph relation; both entities stay' })
  async deleteRelation(@Param('id', ParseUUIDPipe) id: string, @Param('relationId', ParseUUIDPipe) relationId: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.web.deleteRelation(principal, id, relationId);
  }

  @Get('banks/:id/files')
  @Returns('MemoryFileListResponse')
  @Access('viewer', 'memory-bank')
  @ApiOperation({ summary: 'A memory bank\'s memory-tool files, by path, without their text' })
  files(@Param('id', ParseUUIDPipe) id: string, @Query() query: MemoryPageQueryDto, @CurrentPrincipal() principal: Principal): Promise<MemoryFileListResponse> {
    return this.web.fileList(principal, id, query);
  }

  @Get('banks/:id/files/:fileId')
  @Returns('MemoryFileContent')
  @Access('viewer', 'memory-bank')
  @ApiOperation({ summary: 'One memory-tool file\'s text, as stored (masked on write)' })
  file(@Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @CurrentPrincipal() principal: Principal): Promise<MemoryFileContent> {
    return this.web.file(principal, id, fileId);
  }

  @Delete('banks/:id/files/:fileId')
  @HttpCode(204)
  @Access('editor', 'memory-bank')
  @ApiOperation({ summary: 'Delete one memory-tool file and its recall chunks' })
  async deleteFile(@Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.web.deleteFile(principal, id, fileId);
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
