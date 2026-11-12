import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { WORKSPACE_FEATURES, isWorkspaceFeature, isWorkspaceUse, suggestedDisabled, type WorkspaceFeature, type WorkspacePurposeResponse, type WorkspaceUse } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { ttlCache } from '../common/ttl-cache.js';

const FEATURES_TTL_MS = 30_000;

/** What every member's features read carries: the switch, and the purpose that advised it (#934). */
export interface FeatureState {
  disabled: WorkspaceFeature[];
  uses: WorkspaceUse[];
  purposeAsked: boolean;
}

const STATE_SELECT = { disabledFeatures: true, purposeUses: true, purposeAskedAt: true } as const;

// A value a later release dropped from either catalogue reads as nothing.
const stateOf = (row: { disabledFeatures: string[]; purposeUses?: string[]; purposeAskedAt?: Date | null } | null | undefined): FeatureState => ({
  disabled: (row?.disabledFeatures ?? []).filter(isWorkspaceFeature),
  uses: (row?.purposeUses ?? []).filter(isWorkspaceUse),
  purposeAsked: row?.purposeAskedAt != null,
});

/**
 * Which sections a workspace switched off (#604). Read on every request to a
 * toggleable route and every call of a toggleable MCP tool, so it is cached
 * the way `AuthPolicyService` caches a policy: a write here drops this
 * process's copy, and other processes catch up within FEATURES_TTL_MS.
 */
@Injectable()
export class FeaturesService {
  private readonly cache = ttlCache<FeatureState>(FEATURES_TTL_MS);

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
    return [
      ...(this.config.get('WEB_SOURCES_ENABLED', { infer: true }) ? [] : (['sources'] as const)),
      ...(this.config.get('MEMORY_ENABLED', { infer: true }) ? [] : (['memory'] as const)),
    ];
  }

  state(workspaceId: string): Promise<FeatureState> {
    return this.cache.get(workspaceId, async () =>
      stateOf(await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: STATE_SELECT })),
    );
  }

  async disabled(workspaceId: string): Promise<WorkspaceFeature[]> {
    return (await this.state(workspaceId)).disabled;
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
      select: { workspaceId: true, ...STATE_SELECT },
    });
    const stored = new Map(rows.map((r) => [r.workspaceId, stateOf(r)]));
    for (const id of workspaceIds) void this.cache.get(id, async () => stored.get(id) ?? stateOf(null));
    const unavailable = this.unavailable();
    return WORKSPACE_FEATURES.filter((f) => unavailable.includes(f) || workspaceIds.every((id) => stored.get(id)?.disabled.includes(f)));
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

  /** The admin's read (#934): the stored purpose with its description. Uncached — it is a settings page, not a guard. */
  async purpose(workspaceId: string): Promise<WorkspacePurposeResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { ...STATE_SELECT, purposeDescription: true },
    });
    const { disabled, uses } = stateOf(row);
    return {
      workspaceId,
      uses,
      description: row?.purposeDescription ?? null,
      askedAt: row?.purposeAskedAt?.toISOString() ?? null,
      suggestedDisabled: suggestedDisabled(uses),
      disabled,
    };
  }

  /**
   * Saves a purpose and the section list the admin confirmed beside it, in one
   * statement, and stamps the question as asked. No uses with an untouched
   * list is the wizard's Skip. The list is the admin's, not derived here: a
   * purpose advises the switch, it never is one.
   */
  async setPurpose(
    workspaceId: string,
    input: { uses: WorkspaceUse[]; description?: string | null; disabled: WorkspaceFeature[] },
    actorId: string,
  ): Promise<WorkspacePurposeResponse> {
    const data = {
      purposeUses: [...new Set(input.uses)],
      purposeDescription: input.description?.trim() || null,
      purposeAskedAt: new Date(),
      disabledFeatures: [...new Set(input.disabled)],
      updatedBy: actorId,
    };
    await this.prisma.workspaceSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    this.cache.delete(workspaceId);
    return this.purpose(workspaceId);
  }
}
