import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FigmaPickerFileResponse, FigmaPickerFilesResponse, FigmaResolveResponse } from '@knowledge/contracts';
import { Access } from '../auth/access.decorator.js';
import { t } from '../i18n/t.js';
import {
  FigmaPickerFileResponseDto,
  FigmaPickerFilesResponseDto,
  FigmaResolveDto,
  FigmaResolveResponseDto,
  FigmaWorkspaceQueryDto,
} from './embeds.dto.js';
import { FigmaFilesService } from './figma-files.service.js';

/**
 * The editor's Figma picker (#470, docs/features/64), proxied so the browser
 * never holds the connector's token. Editor role: only someone who can write
 * a page can pick what goes in it. Every answer is limited to files an
 * enabled connector's allowlist reaches.
 */
@ApiTags('embeds')
@Controller('v1/embeds/figma')
export class FigmaPickerController {
  constructor(private readonly figma: FigmaFilesService) {}

  @Get('files')
  @Access('editor', 'query')
  @ApiOperation({ summary: 'Figma files the workspace may embed' })
  @ApiOkResponse({ type: FigmaPickerFilesResponseDto })
  async files(@Query() query: FigmaWorkspaceQueryDto): Promise<FigmaPickerFilesResponse> {
    const files = await this.figma.files(query.workspaceId);
    return { connected: await this.figma.connected(query.workspaceId), files };
  }

  @Get('files/:fileKey')
  @Access('editor', 'query')
  @ApiOperation({ summary: 'A Figma file’s pages and top-level frames, with thumbnails, at its current version' })
  @ApiOkResponse({ type: FigmaPickerFileResponseDto })
  async file(@Param('fileKey') fileKey: string, @Query() query: FigmaWorkspaceQueryDto): Promise<FigmaPickerFileResponse> {
    const file = await this.figma.frames(query.workspaceId, fileKey);
    if (!file) throw new NotFoundException(t('error.embed.notAllowlisted'));
    return file;
  }

  @Post('resolve')
  @HttpCode(200)
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Pin a pasted Figma link to the file’s current version' })
  @ApiOkResponse({ type: FigmaResolveResponseDto })
  async resolve(@Body() dto: FigmaResolveDto): Promise<FigmaResolveResponse> {
    const resolved = await this.figma.resolve(dto.workspaceId, dto.url);
    if (!resolved) throw new BadRequestException(t('error.embed.notFigma'));
    return resolved;
  }
}
