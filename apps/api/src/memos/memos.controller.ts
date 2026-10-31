import { Body, Controller, Delete, Get, Param, Post, Query, Redirect } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CreateMemoResponse, MemoDetailResponse, MemoListResponse, MemoResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Returns } from '../common/returns.decorator.js';
import { CreateMemoDto, ListMemosQueryDto } from './dto/memos.dto.js';
import { MemosService } from './memos.service.js';

/**
 * Memos (#551, docs/features/68). `:id` routes resolve the memo's workspace
 * in PG first (source `memo`), so another tenant's id is a 403; whether the
 * caller uploaded it is `MemosService`'s check, a 404 otherwise.
 */
@ApiTags('memos')
@Feature('memos')
@Controller('v1/memos')
export class MemosController {
  constructor(private readonly memos: MemosService) {}

  @Get()
  @Returns('MemoListResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'My memos, newest first, and whether this server can transcribe' })
  list(@Query() query: ListMemosQueryDto, @CurrentPrincipal() principal: Principal): Promise<MemoListResponse> {
    return this.memos.list(principal, query.workspaceId, query.projectId);
  }

  @Post()
  @Returns('CreateMemoResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Reserve a memo and get a presigned upload URL' })
  create(@Body() dto: CreateMemoDto, @CurrentPrincipal() principal: Principal): Promise<CreateMemoResponse> {
    return this.memos.create(principal, dto);
  }

  @Post(':id/finalize')
  @Returns('MemoResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Confirm the recording landed and queue its transcription' })
  async finalize(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.finalize(principal, id) };
  }

  @Post(':id/retry')
  @Returns('MemoResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Resume a failed memo from the step it failed in' })
  async retry(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.retry(principal, id) };
  }

  @Delete(':id')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Delete a memo: its audio and transcript; merge requests it opened stay' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<{ deleted: true }> {
    return this.memos.remove(principal, id);
  }

  @Get(':id')
  @Returns('MemoDetailResponse')
  @Access('viewer', 'memo')
  @ApiOperation({ summary: 'A memo with its transcript and summary' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<MemoDetailResponse> {
    return this.memos.get(principal, id);
  }

  @Get(':id/audio')
  @Access('viewer', 'memo')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect; not useful in the generated client
  async audio(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ url: string; statusCode: number }> {
    return { url: await this.memos.audioUrl(principal, id), statusCode: 302 };
  }
}
