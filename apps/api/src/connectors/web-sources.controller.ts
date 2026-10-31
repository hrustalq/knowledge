import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { CreateSourcePageResponse, DocumentSourceInfo, DocumentSourceWebhookResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { Returns } from '../common/returns.decorator.js';
import { CreateSourcePageDto, RestoreDocumentSourceDto, UpdateDocumentSourceDto } from './web-sources.dto.js';
import { WebSourcesService } from './web-sources.service.js';

/**
 * Source-backed pages (#674): link a page to a URL, and the page's source
 * panel. Every route is `sources`-toggled and 404s while WEB_SOURCES_ENABLED
 * is off. Reading the source is `viewer`; everything that changes what the
 * page shows is `editor`, as editing it would be.
 */
@ApiTags('sources')
@Controller('v1')
@Feature('sources')
export class WebSourcesController {
  constructor(
    private readonly sources: WebSourcesService,
    private readonly permissions: PermissionService,
  ) {}

  @Post('sources')
  @Returns('CreateSourcePageResponse')
  @Access('editor', 'body')
  @ApiOperation({
    summary:
      'Create a source-backed page from a URL (markdown or HTML). The first version is read now; the page is ' +
      'read-only and follows the source on its interval, webhook or Sync now',
  })
  @ApiResponse({ status: 400, description: 'The URL could not be read; `details.needsCredential` when the host refused without one' })
  async link(@Body() dto: CreateSourcePageDto, @CurrentPrincipal() principal: Principal): Promise<CreateSourcePageResponse> {
    // Placing a page under a restricted node is editing that node (#76), as for any new page.
    await this.permissions.requireCreateUnder(await this.permissions.scopeFor(principal, dto.workspaceId), {
      projectId: dto.projectId,
      ...(dto.parentId ? { parentId: dto.parentId } : {}),
    });
    return this.sources.link(dto, principal.userId);
  }

  @Get('documents/:id/source')
  @Returns('DocumentSourceInfo')
  @Access('viewer', 'document')
  @ApiOperation({ summary: "The page's source: where it reads from, when it last checked, paused, failing or behind" })
  info(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentSourceInfo> {
    return this.sources.info(id);
  }

  @Patch('documents/:id/source')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'How often the source is checked' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentSourceDto): Promise<DocumentSourceInfo> {
    return this.sources.setInterval(id, dto.intervalMinutes);
  }

  @Post('documents/:id/source/pause')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Stop writing new versions; they are counted until the source is resumed' })
  pause(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentSourceInfo> {
    return this.sources.pause(id);
  }

  @Post('documents/:id/source/resume')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Follow the source again: a sync is queued and writes whatever it says now' })
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentSourceInfo> {
    return this.sources.resume(id, principal.userId);
  }

  @Post('documents/:id/source/restore')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Restore an earlier revision of the page. Pauses the source and alerts its owner' })
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestoreDocumentSourceDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentSourceInfo> {
    return this.sources.restore(id, dto.revisionId, principal.userId);
  }

  @Post('documents/:id/source/webhook')
  @Returns('DocumentSourceWebhookResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: "A new webhook signing secret for the page's source, shown once; the old one stops working" })
  webhook(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentSourceWebhookResponse> {
    return this.sources.rotateWebhook(id);
  }
}
