import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  KnowledgeHealthBulkResponse,
  KnowledgeHealthListResponse,
  KnowledgeHealthSettingsResponse,
  KnowledgeHealthSummaryResponse,
} from '@knowledge/contracts';
import { HEALTH_ADMIN_BULK_ACTIONS } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import { AccessService } from '../auth/access.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import type { Principal } from '../auth/principal.js';
import { KnowledgeHealthService } from './knowledge-health.service.js';
import {
  KnowledgeHealthBulkDto,
  KnowledgeHealthQueryDto,
  KnowledgeHealthSettingsQueryDto,
  KnowledgeHealthSummaryQueryDto,
  UpdateKnowledgeHealthSettingsDto,
} from './verification.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * The knowledge-health dashboard's API (docs/features/40, issue #66): the
 * filtered list, its counts, bulk actions and the per-workspace settings.
 *
 * Its own controller, so none of these literal segments competes with
 * `DocumentsController`'s `:id`. Reads are `viewer`; bulk is `editor` with an
 * explicit `admin` check for archive/unarchive — a sweep that puts away other
 * people's pages is an admin's act, and `@Access` can express one role only.
 */
@ApiTags('knowledge-health')
@Feature('knowledge-health')
@Controller('v1/knowledge-health')
export class KnowledgeHealthController {
  constructor(
    private readonly health: KnowledgeHealthService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Returns('KnowledgeHealthListResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Pages with their derived verification status, filtered and paged; most neglected first' })
  async list(
    @Query() query: KnowledgeHealthQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<KnowledgeHealthListResponse> {
    return this.health.list(await this.permissions.scopeFor(principal, query.workspaceId), query);
  }

  @Get('summary')
  @Returns('KnowledgeHealthSummaryResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Live counts per filter — no stored aggregate; equals the list totals' })
  async summary(
    @Query() query: KnowledgeHealthSummaryQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<KnowledgeHealthSummaryResponse> {
    return this.health.summary(await this.permissions.scopeFor(principal, query.workspaceId), query.projectId);
  }

  @Post('bulk')
  @Returns('KnowledgeHealthBulkResponse')
  @Access('editor', 'body')
  @ApiOperation({
    summary:
      'One action over up to 200 pages, results per id. A single id from another workspace is a 403 with nothing ' +
      'written (details.foreign). archive / unarchive need admin',
  })
  @ApiResponse({ status: 403, description: 'Some ids belong to another workspace, or archive/unarchive without admin' })
  async bulk(@Body() dto: KnowledgeHealthBulkDto, @CurrentPrincipal() principal: Principal): Promise<KnowledgeHealthBulkResponse> {
    if (HEALTH_ADMIN_BULK_ACTIONS.includes(dto.action)) await this.access.requireRole(principal, dto.workspaceId, 'admin');
    return this.health.bulk(await this.permissions.scopeFor(principal, dto.workspaceId), dto, principal.userId);
  }

  @Get('settings')
  @Returns('KnowledgeHealthSettingsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'The freshness policy: what applies (effective), what the workspace overrides, and the env defaults' })
  settings(@Query() query: KnowledgeHealthSettingsQueryDto): Promise<KnowledgeHealthSettingsResponse> {
    return this.health.settings(query.workspaceId);
  }

  @Patch('settings')
  @Returns('KnowledgeHealthSettingsResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Override part of the policy for this workspace; null on a key goes back to the env default' })
  updateSettings(
    @Query() query: KnowledgeHealthSettingsQueryDto,
    @Body() dto: UpdateKnowledgeHealthSettingsDto,
  ): Promise<KnowledgeHealthSettingsResponse> {
    return this.health.updateSettings(query.workspaceId, dto);
  }
}
