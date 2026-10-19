import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe } from '../common/validation.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { AnalyticsRecorder, noTrackOf, type AnalyticsCaller } from './analytics.recorder.js';
import { PageViewHeartbeatDto, RecordPageViewDto } from './analytics.dto.js';

/** Beacon hits one principal may send a minute: a heartbeat per open tab every 15 s, with room for many tabs. */
const BEACON_PER_MIN = 120;

/**
 * The web page-view beacon (#79, phase 2). Both routes answer 204 whatever
 * happened: a dropped beacon costs one row of analytics, never the reader's
 * page. Past the per-principal rate the hit is dropped, not refused.
 */
@ApiTags('analytics')
@Controller('v1')
export class AnalyticsController {
  constructor(
    private readonly recorder: AnalyticsRecorder,
    private readonly limiter: PublicRateLimiter,
  ) {}

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
