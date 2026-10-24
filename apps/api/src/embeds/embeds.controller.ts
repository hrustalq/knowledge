import { Controller, Get, Param, ParseUUIDPipe, Redirect } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DocumentEmbedsResponse } from '@knowledge/contracts';
import { Access, CookieTokenOk } from '../auth/access.decorator.js';
import { DocumentEmbedsResponseDto } from './embeds.dto.js';
import { EmbedsService } from './embeds.service.js';

/**
 * A page's embeds (#470, docs/features/64). The ACL source is `document`, so
 * the guard resolves `:id` to its workspace (and the page's restrictions)
 * before anything here runs; the service then serves only items a revision of
 * that document references, and only while the allowlist passes.
 */
@ApiTags('embeds')
@Controller('v1/documents/:id/embeds')
export class EmbedsController {
  constructor(private readonly embeds: EmbedsService) {}

  @Get()
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'What the reader can show of each pinned embed item on a page' })
  @ApiOkResponse({ type: DocumentEmbedsResponseDto })
  async status(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentEmbedsResponse> {
    return { items: await this.embeds.documentStatus(id) };
  }

  /** `_` stands for a whole-file item. A redirect, as for attachments: `<img>` cannot send a header. */
  @Get(':fileKey/:nodeId/:version')
  @Access('viewer', 'document')
  @CookieTokenOk()
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint()
  async snapshot(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileKey') fileKey: string,
    @Param('nodeId') nodeId: string,
    @Param('version') version: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.embeds.snapshotUrl(id, { fileKey, nodeId: nodeId === '_' ? '' : nodeId, version });
    return { url, statusCode: 302 };
  }
}
