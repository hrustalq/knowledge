import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiNoContentResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type {
  AnalyticsAgentsResponse,
  AnalyticsOverviewResponse,
  AnalyticsPagesResponse,
  AnalyticsSearchResponse,
  AnalyticsSettingsResponse,
  PageInsightsResponse,
  ProjectAnalyticsResponse,
} from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { AuditService } from '../auth/audit.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { Access, CurrentPrincipal, Feature, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe } from '../common/validation.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { AnalyticsRecorder, noTrackOf, type AnalyticsCaller } from './analytics.recorder.js';
import { AnalyticsQueryService } from './analytics-query.service.js';
import { AnalyticsSettingsService } from './analytics-settings.service.js';
import { toCsv } from './analytics-csv.js';
import {
  AnalyticsExportQueryDto,
  AnalyticsSettingsQueryDto,
  AnalyticsWorkspaceQueryDto,
  PageViewHeartbeatDto,
  ProjectAnalyticsQueryDto,
  RecordPageViewDto,
  UpdateAnalyticsSettingsDto,
} from './analytics.dto.js';
import { Returns } from '../common/returns.decorator.js';

/** Beacon hits one principal may send a minute: a heartbeat per open tab every 15 s, with room for many tabs. */
const BEACON_PER_MIN = 120;

/**
 * Usage analytics over HTTP (#79): the web page-view beacon, the reads of one
 * page and one project, and the admin-only workspace dashboard. Both beacon
 * routes answer 204 whatever happened: a dropped beacon costs one row of
 * analytics, never the reader's page. Past the per-principal rate the hit is
 * dropped, not refused.
 *
 * The workspace routes are `admin`: they carry query text, which people type
 * and which may name things, and every API key that touched the workspace.
 */
@ApiTags('analytics')
@Controller('v1')
export class AnalyticsController {
  constructor(
    private readonly recorder: AnalyticsRecorder,
    private readonly limiter: PublicRateLimiter,
    private readonly query: AnalyticsQueryService,
    private readonly permissions: PermissionService,
    private readonly access: AccessService,
    private readonly settings: AnalyticsSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('analytics/overview')
  @Feature('analytics')
  @Returns('AnalyticsOverviewResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: "The workspace's headline usage: views by traffic class, searches, click-through, assistant and MCP volume" })
  async overview(@Query() q: AnalyticsWorkspaceQueryDto, @CurrentPrincipal() principal: Principal): Promise<AnalyticsOverviewResponse> {
    return this.query.overview(await this.permissions.scopeFor(principal, q.workspaceId), q.days, q.traffic);
  }

  @Get('analytics/pages')
  @Feature('analytics')
  @Returns('AnalyticsPagesResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: "The workspace's most read, never read and dead pages" })
  async pages(@Query() q: AnalyticsWorkspaceQueryDto, @CurrentPrincipal() principal: Principal): Promise<AnalyticsPagesResponse> {
    return this.query.pages(await this.permissions.scopeFor(principal, q.workspaceId), q.days, q.traffic);
  }

  @Get('analytics/search')
  @Feature('analytics')
  @Returns('AnalyticsSearchResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Top queries, queries that found nothing, and web searches whose results nobody opened' })
  search(@Query() q: AnalyticsWorkspaceQueryDto): Promise<AnalyticsSearchResponse> {
    return this.query.search(q.workspaceId, q.days, q.traffic);
  }

  @Get('analytics/agents')
  @Feature('analytics')
  @Returns('AnalyticsAgentsResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'MCP calls by tool and by API key, and the in-app assistant\'s questions and model calls' })
  agents(@Query() q: AnalyticsWorkspaceQueryDto): Promise<AnalyticsAgentsResponse> {
    return this.query.agents(q.workspaceId, q.days);
  }

  @Get('analytics/export.csv')
  @Feature('analytics')
  @Access('admin', 'query')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'One dashboard table as RFC 4180 CSV (formula cells defused); audited' })
  async export(@Query() q: AnalyticsExportQueryDto, @CurrentPrincipal() principal: Principal, @Res() res: Response): Promise<void> {
    const started = Date.now();
    const scope = await this.permissions.scopeFor(principal, q.workspaceId);
    const { columns, rows } = await this.query.report(scope, q.report, q.days, q.traffic);
    await this.audit.record({
      workspaceId: q.workspaceId,
      actor: principal.mode === 'dev' ? 'dev' : principal.userId,
      action: 'analytics.export',
      params: { report: q.report, days: q.days ?? null, traffic: q.traffic ?? null, apiKeyId: principal.apiKey?.id ?? null },
      rowCount: rows.length,
      durationMs: Date.now() - started,
      ok: true,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${q.report}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(toCsv(columns, rows));
  }

  @Get('analytics/settings')
  @Feature('analytics')
  @Returns('AnalyticsSettingsResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: "The workspace's analytics settings: what it asks for, the deployment's ceiling, and what applies" })
  getSettings(@Query() q: AnalyticsSettingsQueryDto): Promise<AnalyticsSettingsResponse> {
    return this.settings.get(q.workspaceId);
  }

  @Put('analytics/settings')
  @Feature('analytics')
  @Returns('AnalyticsSettingsResponse')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Set recording and retention for the workspace; null inherits the env, which is a ceiling' })
  setSettings(@Body() dto: UpdateAnalyticsSettingsDto, @CurrentPrincipal() principal: Principal): Promise<AnalyticsSettingsResponse> {
    return this.settings.set(dto.workspaceId, { enabled: dto.enabled, retentionDays: dto.retentionDays }, principal?.userId);
  }

  @Get('documents/:id/insights')
  @Feature('analytics')
  @Returns('PageInsightsResponse')
  // Anyone who may open the page may see how often it is read: counts only,
  // never who read it.
  @Access('viewer', 'document')
  @ApiOperation({ summary: "One page's reading over the last 30 days: views by traffic class, unique readers, median read time" })
  insights(@Param('id', ParseUuidPipe) id: string): Promise<PageInsightsResponse> {
    return this.query.pageInsights(id);
  }

  @Get('projects/:id/analytics')
  @Feature('analytics')
  @Returns('ProjectAnalyticsResponse')
  // Editors, like the rest of a project's curation: a viewer reads pages, an
  // editor decides which ones nobody needs.
  @Access('editor', 'project')
  @ApiOperation({ summary: "A project's reading: totals, the most read pages, and the pages nobody reads" })
  async project(
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ProjectAnalyticsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProjectAnalyticsResponse> {
    const scope = await this.permissions.scopeFor(principal, await this.access.workspaceOfProject(id));
    return this.query.project(scope, id, q.days, q.traffic);
  }

  @Post('documents/:id/views')
  @HttpCode(204)
  // The guard resolves the page and its permissions: only a page the caller
  // may open gets a view. A beacon is a read, so a read-only key may send it.
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Record that the caller opened this page (the web beacon). Idempotent on viewId' })
  @ApiNoContentResponse()
  async view(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RecordPageViewDto,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<void> {
    if (!(await this.allow(principal))) return;
    await this.recorder.webView(this.callerOf(principal, req, dto.noTrack), id, dto);
  }

  @Post('analytics/views/:viewId/heartbeat')
  @HttpCode(204)
  // No workspace to resolve before the row: the recorder's guarded UPDATE
  // matches the caller's reader key, so it can only touch their own view.
  @ReadKeyOk()
  @ApiOperation({ summary: "Fold a view's active read time into it. Monotonic and capped; a view the caller did not open is unchanged" })
  @ApiNoContentResponse()
  async heartbeat(
    @Param('viewId', ParseUuidPipe) viewId: string,
    @Body() dto: PageViewHeartbeatDto,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<void> {
    if (!(await this.allow(principal))) return;
    await this.recorder.heartbeat(this.callerOf(principal, req, dto.noTrack), viewId, dto.activeMs);
  }

  private allow(principal: Principal): Promise<boolean> {
    return this.limiter.hit(`analytics:${principal.apiKey?.id ?? principal.userId}`, BEACON_PER_MIN, 60_000, true);
  }

  private callerOf(principal: Principal, req: Request, noTrack?: boolean): AnalyticsCaller {
    return { principal, noTrack: noTrack === true || noTrackOf(req.headers) };
  }
}
