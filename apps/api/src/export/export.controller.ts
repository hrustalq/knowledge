import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ExportCapabilitiesResponse, ExportDownloadResponse, ExportJobSummary, ExportListResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { CreateDocumentExportDto, CreateProjectExportDto } from './export.dto.js';
import { ExportService } from './export.service.js';

/**
 * Exports (docs/features/45). Asking for one is a viewer's act — it reads
 * nothing a viewer cannot already read — and hangs off the page or project it
 * covers, so the guard resolves the workspace from that id before the handler
 * runs. The job itself is the `export` source.
 */
@ApiTags('exports')
@Controller('v1')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get('exports/capabilities')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Which formats this deployment can write, and the limits' })
  capabilities(@Query('workspaceId', ParseUUIDPipe) _workspaceId: string): ExportCapabilitiesResponse {
    return this.exports.capabilities();
  }

  @Get('exports')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Your exports in a workspace, newest first; an admin sees everyone’s' })
  list(@Query('workspaceId', ParseUUIDPipe) workspaceId: string, @CurrentPrincipal() principal: Principal): Promise<ExportListResponse> {
    return this.exports.list(workspaceId, principal);
  }

  @Post('documents/:id/exports')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Export a page, or a page and its subpages, as ZIP, HTML or PDF' })
  @ApiResponse({ status: 400, description: 'Too many pages (details.reason export.tooManyPages) or nothing to export' })
  @ApiResponse({ status: 409, description: 'PDF without Gotenberg (details.reason export.formatUnavailable)' })
  exportDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDocumentExportDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ExportJobSummary> {
    return this.exports.createForDocument(id, dto, principal);
  }

  @Post('projects/:id/exports')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'Export every page of a project as ZIP, HTML or PDF' })
  @ApiResponse({ status: 400, description: 'Too many pages (details.reason export.tooManyPages) or nothing to export' })
  @ApiResponse({ status: 409, description: 'PDF without Gotenberg (details.reason export.formatUnavailable)' })
  exportProject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectExportDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ExportJobSummary> {
    return this.exports.createForProject(id, dto, principal);
  }

  @Get('exports/:id')
  @Access('viewer', 'export')
  @ApiOperation({ summary: 'One export — polled while it runs' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ExportJobSummary> {
    return this.exports.get(id, principal);
  }

  /**
   * A URL rather than a 302: the download starts from a click in the app,
   * which can send an Authorization header to ask for it, so no `?token=`.
   */
  @Get('exports/:id/download')
  @Access('viewer', 'export')
  @ApiOperation({ summary: 'A short-lived URL to the finished file' })
  @ApiResponse({ status: 409, description: 'Not finished (details.reason export.notReady)' })
  @ApiResponse({ status: 410, description: 'The file was deleted after EXPORT_TTL_HOURS (details.reason export.expired)' })
  download(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ExportDownloadResponse> {
    return this.exports.download(id, principal);
  }
}
