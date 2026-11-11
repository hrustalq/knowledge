import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Redirect } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CreateMemoResponse, MemoDetailResponse, MemoListResponse, MemoResponse, MemoSpeakersResponse, MemoTypesResponse } from '@knowledge/contracts';
import { MEMO_TYPE_KEY_RE } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { t } from '../i18n/t.js';
import { Returns } from '../common/returns.decorator.js';
import { ConfirmMemoDto, CreateMemoDto, ImportPlaudMemoDto, ListMemosQueryDto, MatchMemoSpeakerDto, MemoTypesQueryDto, RenameMemoDto, SaveMemoTypeDto } from './dto/memos.dto.js';
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
    return this.memos.list(principal, query.workspaceId, query.projectId, query.type);
  }

  // Literal segments before `:id`: Nest matches in declaration order.
  @Get('types')
  @Returns('MemoTypesResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'The kinds of recording this workspace knows: built-in types and its own' })
  async types(@Query() query: MemoTypesQueryDto): Promise<MemoTypesResponse> {
    return { types: await this.memos.types(query.workspaceId) };
  }

  /** Admin: a type's guidance joins the agent's instructions for every member's memos. */
  @Put('types/:key')
  @Returns('MemoTypesResponse')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Change a built-in memo type for this workspace, or add or change one of its own' })
  async saveType(@Param('key') key: string, @Body() dto: SaveMemoTypeDto, @CurrentPrincipal() principal: Principal): Promise<MemoTypesResponse> {
    if (!MEMO_TYPE_KEY_RE.test(key)) throw new BadRequestException(t('error.memo.typeUnknown'));
    return { types: await this.memos.saveType(principal, dto.workspaceId, key, dto) };
  }

  @Delete('types/:key')
  @Returns('MemoTypesResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Put a built-in memo type back as shipped, or delete one of the workspace\'s own' })
  async removeType(@Param('key') key: string, @Query() query: MemoTypesQueryDto): Promise<MemoTypesResponse> {
    return { types: await this.memos.removeType(query.workspaceId, key) };
  }

  @Post()
  @Returns('CreateMemoResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Reserve a memo and get a presigned upload URL' })
  create(@Body() dto: CreateMemoDto, @CurrentPrincipal() principal: Principal): Promise<CreateMemoResponse> {
    return this.memos.create(principal, dto);
  }

  @Post('plaud')
  @Returns('MemoResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Import one of my Plaud recordings as a memo, from the transcript Plaud made (409 until it has one)' })
  async importPlaud(@Body() dto: ImportPlaudMemoDto, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.importPlaud(principal, dto) };
  }

  @Post(':id/finalize')
  @Returns('MemoResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Confirm the recording landed and queue its transcription' })
  async finalize(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.finalize(principal, id) };
  }

  @Post(':id/confirm')
  @Returns('MemoResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Confirm what a memo waiting for review is and where it goes; it is then analysed' })
  async confirm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmMemoDto, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.confirm(principal, id, dto) };
  }

  @Post(':id/retry')
  @Returns('MemoResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Resume a failed memo from the step it failed in' })
  async retry(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.retry(principal, id) };
  }

  @Patch(':id')
  @Returns('MemoResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Rename a memo, or say what kind of recording it is' })
  async rename(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameMemoDto, @CurrentPrincipal() principal: Principal): Promise<MemoResponse> {
    return { memo: await this.memos.update(principal, id, dto) };
  }

  @Put(':id/speakers')
  @Returns('MemoSpeakersResponse')
  @Access('editor', 'memo')
  @ApiOperation({ summary: 'Say who one of the memo\'s speakers is, or that it is nobody here' })
  async matchSpeaker(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MatchMemoSpeakerDto, @CurrentPrincipal() principal: Principal): Promise<MemoSpeakersResponse> {
    return { speakers: await this.memos.matchSpeaker(principal, id, dto.label, dto.userId) };
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
