import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SourceCrawlLimits, SourceSettingsResponse } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * A workspace's crawl limits (#674, phase 3): what it asks for, the
 * deployment's `WEB_SOURCE_CRAWL_*` ceiling, and what applies — all three,
 * because a silent clamp lies about the configuration. A value may only lower
 * its ceiling: a smaller crawl, or a confirmation asked for sooner.
 */
@Injectable()
export class SourceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  ceiling(): SourceCrawlLimits {
    return {
      maxPages: this.config.get('WEB_SOURCE_CRAWL_MAX_PAGES', { infer: true }),
      confirmFirst: this.config.get('WEB_SOURCE_CRAWL_CONFIRM_FIRST', { infer: true }),
      confirmChange: this.config.get('WEB_SOURCE_CRAWL_CONFIRM_CHANGE', { infer: true }),
    };
  }

  async get(workspaceId: string): Promise<SourceSettingsResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { sourceCrawlMaxPages: true, sourceCrawlConfirmFirst: true, sourceCrawlConfirmChange: true },
    });
    const requested = {
      maxPages: row?.sourceCrawlMaxPages ?? null,
      confirmFirst: row?.sourceCrawlConfirmFirst ?? null,
      confirmChange: row?.sourceCrawlConfirmChange ?? null,
    };
    const ceiling = this.ceiling();
    return { workspaceId, requested, ceiling, effective: effectiveCrawlLimits(ceiling, requested) };
  }

  /** What one crawl of this workspace runs under. */
  async limits(workspaceId: string): Promise<SourceCrawlLimits> {
    return (await this.get(workspaceId)).effective;
  }

  /** Store what the workspace asks for — a value past the ceiling is kept and shown clamped. */
  async set(workspaceId: string, requested: SourceSettingsResponse['requested'], actorId?: string): Promise<SourceSettingsResponse> {
    const data = {
      sourceCrawlMaxPages: requested.maxPages,
      sourceCrawlConfirmFirst: requested.confirmFirst,
      sourceCrawlConfirmChange: requested.confirmChange,
      updatedBy: actorId ?? null,
    };
    await this.prisma.workspaceSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    return this.get(workspaceId);
  }
}

export function effectiveCrawlLimits(ceiling: SourceCrawlLimits, requested: SourceSettingsResponse['requested']): SourceCrawlLimits {
  const clamp = (key: keyof SourceCrawlLimits): number => Math.min(requested[key] ?? ceiling[key], ceiling[key]);
  return { maxPages: clamp('maxPages'), confirmFirst: clamp('confirmFirst'), confirmChange: clamp('confirmChange') };
}
