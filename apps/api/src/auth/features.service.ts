import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { WORKSPACE_FEATURES, isWorkspaceFeature, type WorkspaceFeature } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { ttlCache } from '../common/ttl-cache.js';

const FEATURES_TTL_MS = 30_000;

/**
 * Which sections a workspace switched off (#604). Read on every request to a
 * toggleable route and every call of a toggleable MCP tool, so it is cached
 * the way `AuthPolicyService` caches a policy: a write here drops this
 * process's copy, and other processes catch up within FEATURES_TTL_MS.
 */
@Injectable()
export class FeaturesService {
  private readonly cache = ttlCache<WorkspaceFeature[]>(FEATURES_TTL_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Sections this server does not run, whatever a workspace chose: an env
   * ceiling over the toggle (#674). Reported beside the stored choice, never
   * written into it, so turning the env on brings back what the admin chose.
   */
  unavailable(): WorkspaceFeature[] {
    return this.config.get('WEB_SOURCES_ENABLED', { infer: true }) ? [] : ['sources'];
  }

  async disabled(workspaceId: string): Promise<WorkspaceFeature[]> {
    return this.cache.get(workspaceId, async () => {
      const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { disabledFeatures: true } });
      // A value a later release dropped from the catalogue reads as nothing.
      return (row?.disabledFeatures ?? []).filter(isWorkspaceFeature);
    });
  }

  /**
   * The sections that are off, or unavailable here, in **every** one of
   * `workspaceIds` (#945): what an MCP connection reaching them is not offered.
   * One read however many workspaces (a platform admin reaches all of them),
   * which also fills the per-workspace cache. No workspace = every section.
   */
  async offEverywhere(workspaceIds: string[]): Promise<WorkspaceFeature[]> {
    const rows = await this.prisma.workspaceSettings.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { workspaceId: true, disabledFeatures: true },
    });
    const stored = new Map(rows.map((r) => [r.workspaceId, r.disabledFeatures.filter(isWorkspaceFeature)]));
    for (const id of workspaceIds) void this.cache.get(id, async () => stored.get(id) ?? []);
    const unavailable = this.unavailable();
    return WORKSPACE_FEATURES.filter((f) => unavailable.includes(f) || workspaceIds.every((id) => stored.get(id)?.includes(f)));
  }

  /** 404, as if the route or tool did not exist: a switched-off section is absent, not forbidden. */
  async require(workspaceId: string, feature: WorkspaceFeature): Promise<void> {
    if (this.unavailable().includes(feature) || (await this.disabled(workspaceId)).includes(feature)) {
      throw new NotFoundException({ statusCode: 404, message: t('error.feature.disabled', { feature }), feature });
    }
  }

  async set(workspaceId: string, disabled: WorkspaceFeature[], actorId: string): Promise<WorkspaceFeature[]> {
    const disabledFeatures = [...new Set(disabled)];
    await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, disabledFeatures, updatedBy: actorId },
      update: { disabledFeatures, updatedBy: actorId },
    });
    this.cache.delete(workspaceId);
    return disabledFeatures;
  }
}
