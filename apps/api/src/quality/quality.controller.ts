import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DocumentQualityResponse, QualityListResponse, QualitySummaryResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { QualityListQueryDto, QualitySummaryQueryDto } from './quality.dto.js';
import { QualityService } from './quality.service.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Docs quality reads (#74, phase 5): the Quality tab of knowledge health and
 * the page rail. All `viewer`, all under the caller's access scope. The page
 * route has more segments than `documents/:id`, so it does not compete with
 * DocumentsController's.
 */
@ApiTags('quality')
@Controller('v1')
export class QualityController {
  constructor(
    private readonly quality: QualityService,
    private readonly permissions: PermissionService,
  ) {}

  @Get('quality/summary')
  @Returns('QualitySummaryResponse')
  @Access('viewer', 'query')
  @ApiOperation({
    summary:
      "Quality of the workspace or one project from each page's newest score: distribution, dimension means, " +
      'history per audit day, worst pages and most-violated styleguide rules',
  })
  async summary(@Query() query: QualitySummaryQueryDto, @CurrentPrincipal() principal: Principal): Promise<QualitySummaryResponse> {
    return this.quality.summary(await this.permissions.scopeFor(principal, query.workspaceId), query.projectId);
  }

  @Get('quality/documents')
  @Returns('QualityListResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: "Scored pages with their newest score, worst first unless sorted otherwise" })
  async list(@Query() query: QualityListQueryDto, @CurrentPrincipal() principal: Principal): Promise<QualityListResponse> {
    return this.quality.list(await this.permissions.scopeFor(principal, query.workspaceId), query);
  }

  @Get('documents/:id/quality')
  @Returns('DocumentQualityResponse')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      "A page's newest quality score with its issues, near-duplicate peers the caller may open, and its history. " +
      'score is null until the auditor has run',
  })
  async forDocument(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentQualityResponse> {
    return this.quality.forDocument(await this.permissions.scopeForDocument(principal, id), id);
  }
}
