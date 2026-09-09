import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type {
  AiBudgetInfo,
  AiMyUsageResponse,
  AiUsageResponse,
  ListAiBudgetsResponse,
  ListAiUsageLogsResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AiUsageService, periodStart } from './ai-usage.service.js';
import { SetAiBudgetDto } from './ai.dto.js';

/**
 * Token accounting surface (docs/features/12): the Usage and Logs tabs, plus
 * budget administration. Aggregates and the call log are admin-only; a member
 * can always read their own remaining budget, which is what the chat's quota
 * chip shows.
 */
@ApiTags('ai')
@Controller('v1/ai')
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get('usage')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'from', required: false, description: 'ISO timestamp; defaults to 30 days ago' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO timestamp; defaults to now' })
  @ApiQuery({ name: 'groupBy', required: false, enum: ['user', 'model', 'day'] })
  @ApiOperation({ summary: 'Token usage totals, per-bucket breakdown and a daily series' })
  summarize(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: 'user' | 'model' | 'day',
  ): Promise<AiUsageResponse> {
    return this.usage.summarize(workspaceId, { from, to, groupBy });
  }

  @Get('usage/logs')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'operation', required: false, enum: ['ask', 'chat', 'chat-stream', 'review', 'suggest', 'glossary'] })
  @ApiQuery({ name: 'ok', required: false, description: '"true" / "false" to filter by outcome' })
  @ApiOperation({ summary: 'One row per upstream LLM call, newest first (cursor-paginated)' })
  listLogs(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('operation') operation?: string,
    @Query('ok') ok?: string,
  ): Promise<ListAiUsageLogsResponse> {
    return this.usage.listLogs(workspaceId, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      userId,
      operation,
      ok: ok === undefined || ok === '' ? undefined : ok === 'true',
    });
  }

  @Get('usage/me')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: "The caller's own usage this month and remaining budget" })
  async myUsage(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiMyUsageResponse> {
    const [budget, summary] = await Promise.all([
      this.usage.budgetFor(workspaceId, principal.userId),
      this.usage.summarize(workspaceId, { from: periodStart().toISOString(), groupBy: 'user' }),
    ]);
    const mine = summary.buckets.find((b) => b.key === principal.userId);
    return {
      budget,
      calls: mine?.calls ?? 0,
      totalTokens: mine?.totalTokens ?? 0,
      costUsdMicros: mine?.costUsdMicros ?? null,
    };
  }

  @Get('budgets')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Workspace budget envelope plus every user with an override or spend this month' })
  listBudgets(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListAiBudgetsResponse> {
    return this.usage.listBudgets(workspaceId);
  }

  @Put('budgets/:userId')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Set one user’s monthly token budget (null = unlimited)' })
  setBudget(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetAiBudgetDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiBudgetInfo> {
    return this.usage.setUserBudget(dto.workspaceId, userId, dto.monthlyTokenBudget ?? null, principal?.userId);
  }

  @Delete('budgets/:userId')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Drop a per-user override — the workspace default applies again' })
  async clearBudget(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<{ ok: true }> {
    await this.usage.clearUserBudget(workspaceId, userId);
    return { ok: true };
  }
}
