import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PageInsightsResponse, ProjectAnalyticsResponse } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { Access, CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe } from '../common/validation.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { AnalyticsRecorder, noTrackOf, type AnalyticsCaller } from './analytics.recorder.js';
import { AnalyticsQueryService } from './analytics-query.service.js';
import { PageViewHeartbeatDto, ProjectAnalyticsQueryDto, RecordPageViewDto } from './analytics.dto.js';

/** Beacon hits one principal may send a minute: a heartbeat per open tab every 15 s, with room for many tabs. */
const BEACON_PER_MIN = 120;

/**
 * Usage analytics over HTTP (#79): the web page-view beacon and the reads of
 * one page and one project. Both beacon routes answer 204 whatever happened: a
 * dropped beacon costs one row of analytics, never the reader's page. Past the
 * per-principal rate the hit is dropped, not refused.
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
  ) {}

  @Get('documents/:id/insights')
  // Anyone who may open the page may see how often it is read: counts only,
  // never who read it.
  @Access('viewer', 'document')
  @ApiOperation({ summary: "One page's reading over the last 30 days: views by traffic class, unique readers, median read time" })
  insights(@Param('id', ParseUuidPipe) id: string): Promise<PageInsightsResponse> {
    return this.query.pageInsights(id);
  }

  @Get('projects/:id/analytics')
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
