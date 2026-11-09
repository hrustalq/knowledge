import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AiModel } from '@prisma/client';
import type { AiModelSource, AiModelSummary, AiProvider, CostCurrency } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { readCapabilityOverride } from '../agents/model-capabilities.js';
import { t } from '../i18n/t.js';
import { ttlCache } from '../common/ttl-cache.js';

/** How long the model roster is reused before PG is consulted again. */
const CACHE_TTL_MS = 30_000;

const WITH_PROVIDER = { provider: { select: { name: true, provider: true, enabled: true } } } as const;

export type AiModelRow = AiModel & { provider: { name: string; provider: string; enabled: boolean } | null };

export interface UpdateModelInput {
  inChat?: boolean;
  pricePromptPerMTok?: number | null;
  priceCompletionPerMTok?: number | null;
  priceCachedPerMTok?: number | null;
  priceCurrency?: CostCurrency | null;
  capabilities?: string[] | null;
}

/**
 * The models each provider serves (#798, docs/features/12).
 *
 * Routes, agents and threads pin these rows by id with no FK, so everything that
 * removes one nulls the pins in the same transaction ({@link clearPins}). A
 * provider being off removes nothing: it only makes `resolveFor` and the pickers
 * look past its models, and turning it back on restores them.
 *
 * Worker-safe: extraction resolves a model too, so this sits in AiCoreModule.
 */
@Injectable()
export class AiModelsService {
  private readonly cache = ttlCache<AiModelRow[]>(CACHE_TTL_MS);

  constructor(private readonly prisma: PrismaService) {}

  /** Cached, because a chat turn reads it. Off providers are included: callers decide. */
  async roster(workspaceId: string): Promise<AiModelRow[]> {
    return this.cache.get(workspaceId, () => this.prisma.aiModel.findMany({
      where: { workspaceId },
      include: WITH_PROVIDER,
      orderBy: { code: 'asc' },
    }));
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  /** Scoped to the workspace: a pin is a plain uuid, and another tenant's model is no model. */
  find(workspaceId: string, id: string): Promise<AiModelRow | null> {
    return this.prisma.aiModel.findFirst({ where: { id, workspaceId }, include: WITH_PROVIDER });
  }

  /**
   * Adds code names to a provider and skips the ones it already has, so a repeat
   * fetch cannot duplicate a row or reset one an admin has priced.
   */
  async add(
    workspaceId: string,
    providerId: string | null,
    codes: string[],
    source: AiModelSource,
    actorId?: string,
  ): Promise<void> {
    if (providerId) {
      const provider = await this.prisma.aiProvider.findFirst({ where: { id: providerId, workspaceId }, select: { id: true } });
      if (!provider) throw new BadRequestException(t('error.ai.providerNotFound', { id: providerId }));
    }
    const unique = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
    await this.prisma.aiModel.createMany({
      data: unique.map((code) => ({ workspaceId, providerId, code, source, createdBy: actorId ?? null })),
      skipDuplicates: true,
    });
    this.invalidate(workspaceId);
  }

  async update(id: string, input: UpdateModelInput): Promise<AiModelRow> {
    const row = await this.prisma.aiModel.update({
      where: { id },
      data: {
        ...(input.inChat === undefined ? {} : { inChat: input.inChat }),
        ...(input.pricePromptPerMTok === undefined ? {} : { pricePromptPerMTok: input.pricePromptPerMTok }),
        ...(input.priceCompletionPerMTok === undefined ? {} : { priceCompletionPerMTok: input.priceCompletionPerMTok }),
        ...(input.priceCachedPerMTok === undefined ? {} : { priceCachedPerMTok: input.priceCachedPerMTok }),
        ...(input.priceCurrency === undefined ? {} : { priceCurrency: input.priceCurrency }),
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities ?? Prisma.DbNull }),
      },
      include: WITH_PROVIDER,
    });
    this.invalidate(row.workspaceId);
    return row;
  }

  async remove(id: string): Promise<AiModel> {
    const row = await this.prisma.aiModel.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.ai.modelNotFound', { id }));
    await this.prisma.$transaction([...this.clearPins(row.workspaceId, [id]), this.prisma.aiModel.delete({ where: { id } })]);
    this.invalidate(row.workspaceId);
    return row;
  }

  /** A write naming a model of another workspace is refused; a read would only look past it. */
  async assertInWorkspace(workspaceId: string, ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)];
    if (!wanted.length) return;
    const found = await this.prisma.aiModel.count({ where: { workspaceId, id: { in: wanted } } });
    if (found !== wanted.length) throw new BadRequestException(t('error.ai.modelUnknown'));
  }

  /** Every statement that nulls a pin at these models: the trade for pins carrying no FK. */
  clearPins(workspaceId: string, ids: string[]): Prisma.PrismaPromise<unknown>[] {
    const routes = ['chatModelId', 'reviewModelId', 'extractionModelId', 'decisionModelId'] as const;
    return [
      ...routes.map((route) =>
        this.prisma.aiSettings.updateMany({ where: { workspaceId, [route]: { in: ids } }, data: { [route]: null } }),
      ),
      this.prisma.aiAgent.updateMany({ where: { workspaceId, modelId: { in: ids } }, data: { modelId: null } }),
      this.prisma.assistantThread.updateMany({ where: { workspaceId, modelId: { in: ids } }, data: { modelId: null } }),
    ];
  }
}

const decimal = (value: Prisma.Decimal | null): number | null => (value === null ? null : Number(value));

/** The prices of a model row, as the numbers `effectiveModelPrice` and the wire both take. */
export function modelPrices(row: AiModel) {
  return {
    pricePromptPerMTok: decimal(row.pricePromptPerMTok),
    priceCompletionPerMTok: decimal(row.priceCompletionPerMTok),
    priceCachedPerMTok: decimal(row.priceCachedPerMTok),
    priceCurrency: row.priceCurrency as CostCurrency | null,
  };
}

/** A provider being off hides its models. The default config's off is provider `none`. */
export function modelAvailable(row: AiModelRow, defaultKind: string): boolean {
  return row.provider ? row.provider.enabled : defaultKind !== 'none';
}

/** @param defaultKind The default config's provider, which serves its own models. */
export function toModelSummary(row: AiModelRow, defaultKind: string): AiModelSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    providerName: row.provider?.name ?? null,
    code: row.code,
    source: row.source as AiModelSource,
    inChat: row.inChat,
    available: modelAvailable(row, defaultKind),
    kind: (row.provider?.provider ?? defaultKind) as AiProvider,
    capabilities: readCapabilityOverride(row.capabilities),
    ...modelPrices(row),
  };
}
