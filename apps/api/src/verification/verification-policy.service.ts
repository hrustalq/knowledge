import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { KnowledgeHealthSettingsOverride, KnowledgeHealthSettingsValues, TrustWeights } from '@knowledge/contracts';
import {
  SEARCH_COMMUNITY_PRIOR_FLOOR,
  SEARCH_COMMUNITY_PRIOR_WEIGHT,
  SEARCH_MIN_COSINE_SHARE,
  SEARCH_RRF_K,
  TRUST_WEIGHTS,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { ReadCache, READ_CACHE_FAMILIES } from '../cache/read-cache.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The effective freshness policy of a workspace (docs/features/40, issue #66).
 *
 * A leaf, deliberately: `DocumentsService` (to compute an expiry when a page is
 * verified or its interval changes), `SearchService` (to know whether the trust
 * re-rank is on and what "inactive" means) and `VerificationService` all read
 * it, and two of those must not import each other. The row is a sparse
 * override of the env block — `null` inherits — so an empty table reproduces
 * the env behaviour exactly, and the resolution is `COALESCE(row, env)` with no
 * clamping: env values here are defaults, not ceilings. The search knobs
 * (#305, #401) default to code constants rather than env — all but
 * `minCosine`, whose right value depends on the embedding model — and `trustWeights` merges
 * per state, so overriding one weight leaves the others at theirs.
 */
@Injectable()
export class VerificationPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly cache: ReadCache,
  ) {}

  defaults(): KnowledgeHealthSettingsValues {
    return {
      reviewIntervalDays: this.config.get('VERIFICATION_DEFAULT_REVIEW_DAYS', { infer: true }),
      remindBeforeDays: this.config.get('VERIFICATION_REMIND_BEFORE_DAYS', { infer: true }),
      inactiveAfterDays: this.config.get('PAGE_INACTIVE_AFTER_DAYS', { infer: true }),
      emptyMaxChars: this.config.get('EMPTY_PAGE_MAX_CHARS', { infer: true }),
      trustRanking: this.config.get('SEARCH_TRUST_RANKING', { infer: true }),
      rrfK: SEARCH_RRF_K,
      minCosine: this.config.get('SEARCH_MIN_COSINE', { infer: true }),
      minCosineShare: SEARCH_MIN_COSINE_SHARE,
      communityPriorWeight: SEARCH_COMMUNITY_PRIOR_WEIGHT,
      communityPriorFloor: SEARCH_COMMUNITY_PRIOR_FLOOR,
      layeredExpansion: false,
      trustWeights: TRUST_WEIGHTS,
    };
  }

  /** Read on every page detail and search, so through the read cache; `update` is its one writer. */
  override(workspaceId: string): Promise<KnowledgeHealthSettingsOverride> {
    return this.cache.wrap(workspaceId, READ_CACHE_FAMILIES.healthSettings.key(), () => this.readOverride(workspaceId));
  }

  private async readOverride(workspaceId: string): Promise<KnowledgeHealthSettingsOverride> {
    const row = await this.prisma.knowledgeHealthSettings.findUnique({ where: { workspaceId } });
    return {
      reviewIntervalDays: row?.reviewIntervalDays ?? null,
      remindBeforeDays: row?.remindBeforeDays ?? null,
      inactiveAfterDays: row?.inactiveAfterDays ?? null,
      emptyMaxChars: row?.emptyMaxChars ?? null,
      trustRanking: row?.trustRanking ?? null,
      rrfK: row?.rrfK ?? null,
      minCosine: row?.minCosine ?? null,
      minCosineShare: row?.minCosineShare ?? null,
      communityPriorWeight: row?.communityPriorWeight ?? null,
      communityPriorFloor: row?.communityPriorFloor ?? null,
      layeredExpansion: row?.layeredExpansion ?? null,
      trustWeights: (row?.trustWeights as Partial<TrustWeights> | null) ?? null,
    };
  }

  async effective(workspaceId: string): Promise<KnowledgeHealthSettingsValues> {
    const [defaults, override] = [this.defaults(), await this.override(workspaceId)];
    return {
      reviewIntervalDays: override.reviewIntervalDays ?? defaults.reviewIntervalDays,
      remindBeforeDays: override.remindBeforeDays ?? defaults.remindBeforeDays,
      inactiveAfterDays: override.inactiveAfterDays ?? defaults.inactiveAfterDays,
      emptyMaxChars: override.emptyMaxChars ?? defaults.emptyMaxChars,
      trustRanking: override.trustRanking ?? defaults.trustRanking,
      rrfK: override.rrfK ?? defaults.rrfK,
      minCosine: override.minCosine ?? defaults.minCosine,
      minCosineShare: override.minCosineShare ?? defaults.minCosineShare,
      communityPriorWeight: override.communityPriorWeight ?? defaults.communityPriorWeight,
      communityPriorFloor: override.communityPriorFloor ?? defaults.communityPriorFloor,
      layeredExpansion: override.layeredExpansion ?? defaults.layeredExpansion,
      trustWeights: { ...defaults.trustWeights, ...override.trustWeights },
    };
  }

  /** Write the sparse row. Every key is optional; `null` resets that key to "inherit". */
  async update(workspaceId: string, patch: Partial<KnowledgeHealthSettingsOverride>): Promise<void> {
    const { trustWeights, ...rest } = patch;
    const data = {
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      // A JSON column spells "inherit" as SQL NULL, not as a JSON null.
      ...(trustWeights !== undefined ? { trustWeights: trustWeights ? { ...trustWeights } : Prisma.DbNull } : {}),
    };
    await this.prisma.knowledgeHealthSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    await this.cache.invalidate(workspaceId, READ_CACHE_FAMILIES.healthSettings.key());
  }
}

/**
 * When a stamp set at `verifiedAt` runs out. `intervalDays` is the page's own
 * interval or, when null, the workspace's; `0` means never. Pure, so the
 * service, the bulk path and the spec share one arithmetic.
 */
export function expiryFor(verifiedAt: Date, intervalDays: number | null | undefined, workspaceDefault: number): Date | null {
  const days = intervalDays ?? workspaceDefault;
  if (!days || days <= 0) return null;
  return new Date(verifiedAt.getTime() + days * 86_400_000);
}
