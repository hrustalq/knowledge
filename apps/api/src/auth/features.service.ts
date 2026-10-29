import { Injectable, NotFoundException } from '@nestjs/common';
import { isWorkspaceFeature, type WorkspaceFeature } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';

const FEATURES_TTL_MS = 30_000;

/**
 * Which sections a workspace switched off (#604). Read on every request to a
 * toggleable route and every call of a toggleable MCP tool, so it is cached
 * the way `AuthPolicyService` caches a policy: a write here drops this
 * process's copy, and other processes catch up within FEATURES_TTL_MS.
 */
@Injectable()
export class FeaturesService {
  private readonly cache = new Map<string, { at: number; value: WorkspaceFeature[] }>();

  constructor(private readonly prisma: PrismaService) {}

  async disabled(workspaceId: string): Promise<WorkspaceFeature[]> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < FEATURES_TTL_MS) return hit.value;
    const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { disabledFeatures: true } });
    // A value a later release dropped from the catalogue reads as nothing.
    const value = (row?.disabledFeatures ?? []).filter(isWorkspaceFeature);
    this.cache.set(workspaceId, { at: Date.now(), value });
    return value;
  }

  /** 404, as if the route or tool did not exist: a switched-off section is absent, not forbidden. */
  async require(workspaceId: string, feature: WorkspaceFeature): Promise<void> {
    if ((await this.disabled(workspaceId)).includes(feature)) {
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
