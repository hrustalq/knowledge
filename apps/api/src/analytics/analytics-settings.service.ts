import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AnalyticsSettingsResponse, AnalyticsSettingsValues } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalyticsRecorder } from './analytics.recorder.js';
import { effectiveAnalytics } from './analytics-settings.js';

/**
 * A workspace's analytics settings (#79): what it asks for, the deployment's
 * ceiling, and what applies — all three, because a silent clamp lies about
 * the configuration.
 */
@Injectable()
export class AnalyticsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly recorder: AnalyticsRecorder,
  ) {}

  ceiling(): AnalyticsSettingsValues {
    return {
      enabled: this.config.get('ANALYTICS_ENABLED', { infer: true }),
      retentionDays: this.config.get('ANALYTICS_RETENTION_DAYS', { infer: true }),
    };
  }

  async get(workspaceId: string): Promise<AnalyticsSettingsResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { analyticsEnabled: true, analyticsRetentionDays: true },
    });
    const ceiling = this.ceiling();
    return {
      workspaceId,
      requested: { enabled: row?.analyticsEnabled ?? null, retentionDays: row?.analyticsRetentionDays ?? null },
      ceiling,
      effective: effectiveAnalytics(ceiling, row),
      queryTextDays: this.config.get('ANALYTICS_QUERY_TEXT_DAYS', { infer: true }),
      deadPageDays: this.config.get('ANALYTICS_DEAD_PAGE_DAYS', { infer: true }),
    };
  }

  /** Store what the workspace asks for — a value past the ceiling is kept and shown clamped. */
  async set(
    workspaceId: string,
    requested: { enabled: boolean | null; retentionDays: number | null },
    actorId?: string,
  ): Promise<AnalyticsSettingsResponse> {
    const data = { analyticsEnabled: requested.enabled, analyticsRetentionDays: requested.retentionDays, updatedBy: actorId ?? null };
    await this.prisma.workspaceSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    // This process records under the new setting at once; the others within the recorder's minute.
    this.recorder.forget(workspaceId);
    return this.get(workspaceId);
  }
}
