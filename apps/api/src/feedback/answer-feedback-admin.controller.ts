import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ANSWER_SURFACES } from '@knowledge/contracts';
import type { AnswerFeedbackSummary, ListAnswerFeedbackResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { EXPORT_MAX_ROWS, FeedbackDatasetService } from './feedback-dataset.service.js';

/**
 * The admin read side of answer feedback (docs/features/38, issue #67 phase
 * 5): the Feedback tab's list and counts, and the NDJSON export the backtest
 * replays. Under `v1/ai` with the other admin tabs. Every route is
 * `@Access('admin', 'query')`: the rows hold question text and user ids.
 * Literal segments are declared before anything parameterised — there is no
 * `:id` here today, and this keeps it true when one arrives.
 */
@ApiTags('ai')
@Controller('v1/ai')
export class AnswerFeedbackAdminController {
  constructor(
    private readonly dataset: FeedbackDatasetService,
    private readonly audit: AuditService,
  ) {}

  @Get('feedback/summary')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'from', required: false, description: 'ISO timestamp; defaults to 30 days ago' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO timestamp; defaults to now' })
  @ApiOperation({ summary: 'Votes, implicit signals and reports in a window, counted by rating, reason, surface and status' })
  summary(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AnswerFeedbackSummary> {
    return this.dataset.summary(workspaceId, { from, to });
  }

  @Get('feedback/export')
  @Access('admin', 'query')
  @ApiProduces('application/x-ndjson')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'from', required: false, description: 'ISO timestamp; defaults to the beginning' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO timestamp; defaults to now' })
  @ApiOperation({
    summary: `The labelled retrieval dataset as NDJSON, one FeedbackBacktestCase per usable vote (at most ${EXPORT_MAX_ROWS} votes read); audited`,
  })
  async export(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const started = Date.now();
    const base = {
      workspaceId,
      actor: principal.mode === 'dev' ? 'dev' : principal.userId,
      action: 'feedback.export' as const,
      params: { from: from ?? null, to: to ?? null, apiKeyId: principal.apiKey?.id ?? null },
    };
    const stream = this.dataset.cases(workspaceId, { from, to });
    // The first pull validates the window before any header is committed, so a
    // bad `from` is still a 400 envelope rather than a half-written body.
    let next = await stream.next();
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-${workspaceId}-${new Date().toISOString().slice(0, 10)}.ndjson"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200);
    let written = 0;
    try {
      while (!next.done) {
        res.write(`${JSON.stringify(next.value)}\n`);
        written += 1;
        next = await stream.next();
      }
      res.end();
      await this.audit.record({
        ...base,
        params: { ...base.params, read: next.value.read, truncated: next.value.truncated },
        rowCount: written,
        durationMs: Date.now() - started,
        ok: true,
      });
    } catch (e) {
      res.destroy();
      await this.audit.record({ ...base, rowCount: written, durationMs: Date.now() - started, ok: false, error: (e as Error).message });
      throw e;
    }
  }

  @Get('feedback')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'kind', required: false, enum: ['vote', 'low-confidence', 'no-answer'] })
  @ApiQuery({ name: 'rating', required: false, enum: ['up', 'down'] })
  @ApiQuery({ name: 'reason', required: false })
  @ApiQuery({ name: 'surface', required: false, enum: [...ANSWER_SURFACES] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Votes and implicit signals, newest first (cursor-paginated)' })
  list(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('kind') kind?: string,
    @Query('rating') rating?: string,
    @Query('reason') reason?: string,
    @Query('surface') surface?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ListAnswerFeedbackResponse> {
    return this.dataset.list(workspaceId, {
      kind,
      rating,
      reason,
      surface,
      from,
      to,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
