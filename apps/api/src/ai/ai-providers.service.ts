import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AiProvider } from '@prisma/client';
import type { AiProviderSummary, AiProviderKind } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readCapabilityOverride } from '../agents/model-capabilities.js';
import { decryptSecret, encryptSecret, maskSecret, MissingEncryptionKeyError, parseKey } from './secret-box.js';
import { t } from '../i18n/t.js';

/** How long the provider roster is reused before PG is consulted again. */
const CACHE_TTL_MS = 30_000;

export interface UpsertProviderInput {
  name: string;
  provider: AiProviderKind;
  baseUrl?: string | null;
  model: string;
  /** Plaintext; encrypted before it touches the database. `null` clears. */
  apiKey?: string | null;
  temperature?: number | null;
  maxToolCalls?: number | null;
  timeoutMs?: number | null;
  pricePromptPerMTok?: number | null;
  priceCompletionPerMTok?: number | null;
  /** AgentCapability[] declared by an admin, overriding the model table. */
  capabilities?: string[] | null;
  enabled?: boolean;
}

/**
 * Named provider profiles (docs/features/12).
 *
 * A workspace can define several — "DeepSeek prod", "GPT-4o", "Local Ollama" —
 * and route each purpose at one of them. Profiles are strictly additive: a
 * workspace with none falls back to the single inline config on ai_settings
 * and then to the ASSISTANT_* env vars, which is exactly how it behaved before
 * this existed.
 *
 * Worker-safe: no controllers, no auth dependencies, so WorkerModule can use
 * it to route relation extraction (the same reason EventsModule is split from
 * EventsApiModule).
 */
@Injectable()
export class AiProvidersService {
  private readonly cache = new Map<string, { at: number; providers: AiProvider[] }>();
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
  }

  async list(workspaceId: string): Promise<AiProviderSummary[]> {
    const providers = await this.prisma.aiProvider.findMany({
      where: { workspaceId },
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    });
    return providers.map((p) => this.toSummary(p));
  }

  async get(id: string): Promise<AiProviderSummary> {
    return this.toSummary(await this.getOrThrow(id));
  }

  /** The raw row, with its credential decrypted — for config resolution only. */
  async resolveRow(id: string): Promise<{ row: AiProvider; apiKey: string | null } | null> {
    const row = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!row || !row.enabled) return null;
    return { row, apiKey: decryptSecret(row.apiKeyCipher, this.key) };
  }

  /** Cached roster used when routing a turn — one query per workspace per TTL. */
  async enabledProviders(workspaceId: string): Promise<AiProvider[]> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.providers;
    const providers = await this.prisma.aiProvider.findMany({
      where: { workspaceId, enabled: true },
      orderBy: { name: 'asc' },
    });
    this.cache.set(workspaceId, { at: Date.now(), providers });
    return providers;
  }

  decrypt(row: AiProvider): string | null {
    return decryptSecret(row.apiKeyCipher, this.key);
  }

  async create(workspaceId: string, input: UpsertProviderInput, actorId?: string): Promise<AiProviderSummary> {
    const clash = await this.prisma.aiProvider.findUnique({
      where: { workspaceId_name: { workspaceId, name: input.name } },
    });
    if (clash) throw new ConflictException(t('error.ai.providerNameTaken', { name: input.name }));

    const row = await this.prisma.aiProvider.create({
      data: {
        workspaceId,
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl ?? null,
        model: input.model,
        apiKeyCipher: this.encrypt(input.apiKey),
        temperature: input.temperature ?? null,
        maxToolCalls: input.maxToolCalls ?? null,
        timeoutMs: input.timeoutMs ?? null,
        pricePromptPerMTok: input.pricePromptPerMTok ?? null,
        priceCompletionPerMTok: input.priceCompletionPerMTok ?? null,
        capabilities: input.capabilities ?? Prisma.DbNull,
        enabled: input.enabled ?? true,
        createdBy: actorId ?? null,
      },
    });
    this.cache.delete(workspaceId);
    return this.toSummary(row);
  }

  async update(id: string, input: Partial<UpsertProviderInput>): Promise<AiProviderSummary> {
    const current = await this.getOrThrow(id);
    if (input.name && input.name !== current.name) {
      const clash = await this.prisma.aiProvider.findUnique({
        where: { workspaceId_name: { workspaceId: current.workspaceId, name: input.name } },
      });
      if (clash) throw new ConflictException(t('error.ai.providerNameTaken', { name: input.name }));
    }
    const row = await this.prisma.aiProvider.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.model === undefined ? {} : { model: input.model }),
        // undefined keeps the stored credential, null clears it — the same
        // write-only convention the inline provider key uses.
        ...(input.apiKey === undefined ? {} : { apiKeyCipher: this.encrypt(input.apiKey) }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities ?? Prisma.DbNull }),
        ...(input.pricePromptPerMTok === undefined ? {} : { pricePromptPerMTok: input.pricePromptPerMTok }),
        ...(input.priceCompletionPerMTok === undefined ? {} : { priceCompletionPerMTok: input.priceCompletionPerMTok }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    });
    this.cache.delete(current.workspaceId);
    return this.toSummary(row);
  }

  /**
   * Deleting a profile clears every reference to it — the three routing
   * columns and any thread pinned to it — so a dangling id can never send a
   * turn to a provider that no longer exists. This is the trade for having no
   * foreign keys on those columns (house style, see the schema comment).
   */
  async remove(id: string): Promise<void> {
    const row = await this.getOrThrow(id);
    await this.prisma.$transaction([
      this.prisma.aiSettings.updateMany({
        where: { workspaceId: row.workspaceId, chatProviderId: id },
        data: { chatProviderId: null },
      }),
      this.prisma.aiSettings.updateMany({
        where: { workspaceId: row.workspaceId, reviewProviderId: id },
        data: { reviewProviderId: null },
      }),
      this.prisma.aiSettings.updateMany({
        where: { workspaceId: row.workspaceId, extractionProviderId: id },
        data: { extractionProviderId: null },
      }),
      this.prisma.assistantThread.updateMany({ where: { providerId: id }, data: { providerId: null } }),
      this.prisma.aiProvider.delete({ where: { id } }),
    ]);
    this.cache.delete(row.workspaceId);
  }

  async recordCheck(id: string, ok: boolean, error?: string): Promise<void> {
    const row = await this.prisma.aiProvider.update({
      where: { id },
      data: {
        lastStatus: ok ? 'ok' : 'error',
        lastError: ok ? null : (error?.slice(0, 500) ?? 'unknown error'),
        lastCheckedAt: new Date(),
      },
    });
    this.cache.delete(row.workspaceId);
  }

  private async getOrThrow(id: string): Promise<AiProvider> {
    const row = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.ai.providerNotFound', { id }));
    return row;
  }

  private encrypt(apiKey: string | null | undefined): string | null {
    if (apiKey === undefined || apiKey === null || apiKey === '') return null;
    try {
      return encryptSecret(apiKey, this.key);
    } catch (err) {
      if (err instanceof MissingEncryptionKeyError) throw new MissingEncryptionKeyError();
      throw err;
    }
  }

  private toSummary(row: AiProvider): AiProviderSummary {
    const key = decryptSecret(row.apiKeyCipher, this.key);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      provider: row.provider as AiProviderKind,
      baseUrl: row.baseUrl,
      model: row.model,
      hasApiKey: row.apiKeyCipher !== null,
      apiKeyHint: key ? maskSecret(key) : null,
      temperature: row.temperature,
      maxToolCalls: row.maxToolCalls,
      timeoutMs: row.timeoutMs,
      pricePromptPerMTok: row.pricePromptPerMTok ? Number(row.pricePromptPerMTok) : null,
      priceCompletionPerMTok: row.priceCompletionPerMTok ? Number(row.priceCompletionPerMTok) : null,
      capabilities: readCapabilityOverride(row.capabilities),
      enabled: row.enabled,
      status: (row.lastStatus as AiProviderSummary['status']) ?? 'unknown',
      lastError: row.lastError,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
