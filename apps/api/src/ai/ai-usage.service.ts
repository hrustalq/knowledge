import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type {
  AiBudgetInfo,
  AiUsageBucket,
  AiUsageLogEntry,
  AiUsageOperation,
  AiUsageResponse,
  AiUsageSeriesPoint,
  ListAiBudgetsResponse,
  ListAiUsageLogsResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService, type ResolvedAiConfig } from './ai-config.service.js';
import { t } from '../i18n/t.js';

/** Token counts as reported by the provider (OpenAI-shaped `usage` block). */
export interface AiUsageTokens {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The provider returned no usage block, so these are locally estimated. */
  estimated: boolean;
}

export interface AiUsageRecordInput {
  config: ResolvedAiConfig;
  userId: string;
  operation: AiUsageOperation;
  tokens: AiUsageTokens;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  error?: string;
  threadId?: string;
  toolCallCount?: number;
}

const LOG_PAGE_SIZE = 50;

/**
 * Crude token estimate for providers that ignore `stream_options.include_usage`
 * (several OpenAI-compatible servers do). ~4 characters per token is the usual
 * English rule of thumb; rows built this way are flagged `estimated` so nobody
 * mistakes them for billing truth.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** First instant of the current accounting month, UTC. */
export function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Token accounting for every upstream LLM call (docs/features/12).
 *
 * `record` is fire-and-forget in the same sense as ActivityService.record: a
 * failure here must never turn a working answer into an error, so it only
 * warns. `assertWithinBudget` is the opposite — it runs *before* the call and
 * is allowed to throw, which is the whole point of a quota.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
  ) {}

  async record(input: AiUsageRecordInput): Promise<void> {
    const { config, tokens } = input;
    try {
      await this.prisma.aiUsage.create({
        data: {
          workspaceId: config.workspaceId,
          userId: input.userId,
          operation: input.operation,
          provider: config.provider,
          model: config.model,
          providerId: config.providerId,
          promptTokens: tokens.promptTokens,
          completionTokens: tokens.completionTokens,
          totalTokens: tokens.totalTokens,
          estimated: tokens.estimated,
          costUsdMicros: this.aiConfig.estimateCostMicros(config, tokens.promptTokens, tokens.completionTokens),
          durationMs: input.durationMs,
          ok: input.ok,
          errorCode: input.errorCode ?? null,
          error: input.error?.slice(0, 500) ?? null,
          threadId: input.threadId ?? null,
          toolCallCount: input.toolCallCount ?? 0,
        },
      });
    } catch (e) {
      this.logger.warn(`AI usage record failed (non-fatal): ${(e as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  /**
   * Throws 429 ASSISTANT_BUDGET_EXCEEDED when the caller — or the workspace as
   * a whole — has spent its monthly allowance. A no-op unless an admin turned
   * enforcement on, so existing installs are unaffected.
   *
   * Checked against tokens already spent this month, not against a reservation:
   * a single call can overshoot the budget by its own size. Reserving up front
   * would mean guessing the completion length before generating it.
   */
  async assertWithinBudget(workspaceId: string, userId: string): Promise<void> {
    const settings = await this.prisma.aiSettings.findUnique({ where: { workspaceId } });
    if (!settings?.enforceBudget) return;

    const start = periodStart();

    const wsBudget = settings.workspaceMonthlyTokenBudget;
    if (wsBudget != null) {
      const used = await this.usedTokens(workspaceId, undefined, start);
      if (used >= Number(wsBudget)) {
        throw this.budgetExceeded('workspace', used, Number(wsBudget), start);
      }
    }

    const override = await this.prisma.aiUserBudget.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    const userBudget = override ? override.monthlyTokenBudget : settings.defaultUserMonthlyTokenBudget;
    if (userBudget != null) {
      const used = await this.usedTokens(workspaceId, userId, start);
      if (used >= Number(userBudget)) {
        throw this.budgetExceeded('user', used, Number(userBudget), start);
      }
    }
  }

  /**
   * Flat-extras pattern (CLAUDE.md): extras sit alongside statusCode/message
   * and ApiExceptionFilter hoists them into `details` — never nest `details`
   * by hand.
   */
  private budgetExceeded(scope: 'user' | 'workspace', used: number, budget: number, start: Date): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'ASSISTANT_BUDGET_EXCEEDED',
        message: t(scope === 'user' ? 'error.assistant.budgetUser' : 'error.assistant.budgetWorkspace'),
        scope,
        usedTokens: used,
        monthlyTokenBudget: budget,
        periodStart: start.toISOString(),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async usedTokens(workspaceId: string, userId: string | undefined, start: Date): Promise<number> {
    const agg = await this.prisma.aiUsage.aggregate({
      where: { workspaceId, ...(userId ? { userId } : {}), createdAt: { gte: start } },
      _sum: { totalTokens: true },
    });
    return agg._sum.totalTokens ?? 0;
  }

  /** Budget state for one principal — the chat's remaining-tokens chip. */
  async budgetFor(workspaceId: string, userId: string): Promise<AiBudgetInfo> {
    const [settings, override] = await Promise.all([
      this.prisma.aiSettings.findUnique({ where: { workspaceId } }),
      this.prisma.aiUserBudget.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } }),
    ]);
    const start = periodStart();
    const used = await this.usedTokens(workspaceId, userId, start);
    const raw = override ? override.monthlyTokenBudget : (settings?.defaultUserMonthlyTokenBudget ?? null);
    const budget = raw == null ? null : Number(raw);
    return {
      userId,
      monthlyTokenBudget: budget,
      overridden: override != null,
      usedTokens: used,
      remainingTokens: budget == null ? null : Math.max(0, budget - used),
      enforced: settings?.enforceBudget ?? false,
      periodStart: start.toISOString(),
    };
  }

  /** Admin view: the workspace envelope plus every member who has an override or has spent tokens. */
  async listBudgets(workspaceId: string): Promise<ListAiBudgetsResponse> {
    const settings = await this.prisma.aiSettings.findUnique({ where: { workspaceId } });
    const start = periodStart();

    const [wsUsed, overrides, spenders] = await Promise.all([
      this.usedTokens(workspaceId, undefined, start),
      this.prisma.aiUserBudget.findMany({ where: { workspaceId } }),
      this.prisma.aiUsage.groupBy({
        by: ['userId'],
        where: { workspaceId, createdAt: { gte: start } },
        _sum: { totalTokens: true },
      }),
    ]);

    const usedByUser = new Map(spenders.map((s) => [s.userId, s._sum.totalTokens ?? 0]));
    const overrideByUser = new Map(overrides.map((o) => [o.userId, o]));
    const defaultBudget =
      settings?.defaultUserMonthlyTokenBudget == null ? null : Number(settings.defaultUserMonthlyTokenBudget);

    const userIds = [...new Set([...usedByUser.keys(), ...overrideByUser.keys()])];
    const users: AiBudgetInfo[] = userIds.map((userId) => {
      const override = overrideByUser.get(userId);
      const raw = override ? override.monthlyTokenBudget : settings?.defaultUserMonthlyTokenBudget;
      const budget = raw == null ? null : Number(raw);
      const used = usedByUser.get(userId) ?? 0;
      return {
        userId,
        monthlyTokenBudget: budget,
        overridden: override != null,
        usedTokens: used,
        remainingTokens: budget == null ? null : Math.max(0, budget - used),
        enforced: settings?.enforceBudget ?? false,
        periodStart: start.toISOString(),
      };
    });
    users.sort((a, b) => b.usedTokens - a.usedTokens);

    const wsBudget =
      settings?.workspaceMonthlyTokenBudget == null ? null : Number(settings.workspaceMonthlyTokenBudget);
    return {
      workspace: {
        monthlyTokenBudget: wsBudget,
        usedTokens: wsUsed,
        remainingTokens: wsBudget == null ? null : Math.max(0, wsBudget - wsUsed),
        enforced: settings?.enforceBudget ?? false,
        periodStart: start.toISOString(),
      },
      users: users.length > 0 || defaultBudget != null ? users : [],
    };
  }

  async setUserBudget(
    workspaceId: string,
    userId: string,
    monthlyTokenBudget: number | null,
    actorId: string | undefined,
  ): Promise<AiBudgetInfo> {
    await this.prisma.aiUserBudget.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, monthlyTokenBudget, updatedBy: actorId ?? null },
      update: { monthlyTokenBudget, updatedBy: actorId ?? null },
    });
    return this.budgetFor(workspaceId, userId);
  }

  async clearUserBudget(workspaceId: string, userId: string): Promise<void> {
    await this.prisma.aiUserBudget
      .delete({ where: { workspaceId_userId: { workspaceId, userId } } })
      .catch(() => undefined); // already absent — idempotent
  }

  // -------------------------------------------------------------------------
  // Aggregates & log
  // -------------------------------------------------------------------------

  async summarize(
    workspaceId: string,
    opts: { from?: string; to?: string; groupBy?: 'user' | 'model' | 'day' },
  ): Promise<AiUsageResponse> {
    const to = opts.to ? new Date(opts.to) : new Date();
    const from = opts.from ? new Date(opts.from) : new Date(to.getTime() - 30 * 24 * 3600_000);
    const groupBy = opts.groupBy ?? 'user';
    const where = { workspaceId, createdAt: { gte: from, lte: to } };

    // Day buckets and the series both need per-day rollups, which Prisma's
    // groupBy cannot express (no date_trunc) — so rows are folded in Node.
    // Bounded by the date range the admin picked, not by table size.
    const rows = await this.prisma.aiUsage.findMany({
      where,
      select: {
        userId: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costUsdMicros: true,
        ok: true,
        createdAt: true,
      },
    });

    const fold = new Map<string, AiUsageBucket>();
    const series = new Map<string, AiUsageSeriesPoint>();
    const totals = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsdMicros: null as number | null,
      unpricedCalls: 0,
      errors: 0,
    };

    for (const r of rows) {
      const day = r.createdAt.toISOString().slice(0, 10);
      const key = groupBy === 'user' ? r.userId : groupBy === 'model' ? r.model : day;

      const bucket = fold.get(key) ?? {
        key,
        label: key,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsdMicros: null,
        errors: 0,
      };
      bucket.calls += 1;
      bucket.promptTokens += r.promptTokens;
      bucket.completionTokens += r.completionTokens;
      bucket.totalTokens += r.totalTokens;
      if (r.costUsdMicros != null) bucket.costUsdMicros = (bucket.costUsdMicros ?? 0) + r.costUsdMicros;
      if (!r.ok) bucket.errors += 1;
      fold.set(key, bucket);

      const point = series.get(day) ?? { date: day, totalTokens: 0, calls: 0, costUsdMicros: null };
      point.calls += 1;
      point.totalTokens += r.totalTokens;
      if (r.costUsdMicros != null) point.costUsdMicros = (point.costUsdMicros ?? 0) + r.costUsdMicros;
      series.set(day, point);

      totals.calls += 1;
      totals.promptTokens += r.promptTokens;
      totals.completionTokens += r.completionTokens;
      totals.totalTokens += r.totalTokens;
      if (r.costUsdMicros != null) totals.costUsdMicros = (totals.costUsdMicros ?? 0) + r.costUsdMicros;
      else totals.unpricedCalls += 1;
      if (!r.ok) totals.errors += 1;
    }

    const buckets = [...fold.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    if (groupBy === 'user') await this.labelUsers(buckets);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      totals,
      buckets,
      series: [...series.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  async listLogs(
    workspaceId: string,
    opts: { cursor?: string; limit?: number; userId?: string; operation?: string; ok?: boolean },
  ): Promise<ListAiUsageLogsResponse> {
    const limit = Math.min(opts.limit ?? LOG_PAGE_SIZE, 200);
    const rows = await this.prisma.aiUsage.findMany({
      where: {
        workspaceId,
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(opts.operation ? { operation: opts.operation } : {}),
        ...(opts.ok === undefined ? {} : { ok: opts.ok }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, limit);
    const labels = await this.userLabels(page.map((r) => r.userId));
    const entries: AiUsageLogEntry[] = page.map((r) => ({
      id: r.id,
      userId: r.userId,
      userLabel: labels.get(r.userId) ?? r.userId,
      operation: r.operation as AiUsageOperation,
      provider: r.provider,
      model: r.model,
      providerId: r.providerId,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      estimated: r.estimated,
      costUsdMicros: r.costUsdMicros,
      durationMs: r.durationMs,
      ok: r.ok,
      errorCode: r.errorCode,
      error: r.error,
      threadId: r.threadId,
      toolCallCount: r.toolCallCount,
      createdAt: r.createdAt.toISOString(),
    }));
    return { entries, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  }

  private async labelUsers(buckets: AiUsageBucket[]): Promise<void> {
    const labels = await this.userLabels(buckets.map((b) => b.key));
    for (const b of buckets) b.label = labels.get(b.key) ?? b.key;
  }

  /**
   * Resolves user ids to emails. The dev principal's all-zeros id has no users
   * row (AUTH_MODE=none), so it is named explicitly rather than showing a UUID.
   */
  private async userLabels(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true, displayName: true },
    });
    const map = new Map(users.map((u) => [u.id, u.email || u.displayName]));
    for (const id of unique) {
      if (!map.has(id) && id === '00000000-0000-0000-0000-000000000000') map.set(id, 'dev (AUTH_MODE=none)');
    }
    return map;
  }
}
