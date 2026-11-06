import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiProvider } from '@prisma/client';
import type { AiProviderSummary, AiProviderKind } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiModelsService } from './ai-models.service.js';
import { decryptSecret, encryptSecret, maskSecret, MissingEncryptionKeyError, parseKey } from './secret-box.js';
import { t } from '../i18n/t.js';

export interface UpsertProviderInput {
  name: string;
  provider: AiProviderKind;
  baseUrl?: string | null;
  /** Plaintext; encrypted before it touches the database. `null` clears. */
  apiKey?: string | null;
  temperature?: number | null;
  maxToolCalls?: number | null;
  timeoutMs?: number | null;
  enabled?: boolean;
}

/**
 * Named providers (docs/features/12): a connection each, serving the models in
 * `ai_models`. A workspace can define several — "DeepSeek prod", "Local Ollama".
 * They are strictly additive: a workspace with none falls back to the single
 * inline config on ai_settings and then to the ASSISTANT_* env vars, which is
 * exactly how it behaved before this existed.
 *
 * Worker-safe: no controllers, no auth dependencies, so WorkerModule can use
 * it to route relation extraction (the same reason EventsModule is split from
 * EventsApiModule).
 */
@Injectable()
export class AiProvidersService {
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly models: AiModelsService,
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
        apiKeyCipher: this.encrypt(input.apiKey),
        temperature: input.temperature ?? null,
        maxToolCalls: input.maxToolCalls ?? null,
        timeoutMs: input.timeoutMs ?? null,
        enabled: input.enabled ?? true,
        createdBy: actorId ?? null,
      },
    });
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
        // undefined keeps the stored credential, null clears it — the same
        // write-only convention the inline provider key uses.
        ...(input.apiKey === undefined ? {} : { apiKeyCipher: this.encrypt(input.apiKey) }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    });
    // The roster carries the provider's name and whether it is on.
    this.models.invalidate(current.workspaceId);
    return this.toSummary(row);
  }

  /**
   * Deleting a provider takes its models (FK cascade) and clears every pin at
   * them, so a dangling id can never send a turn anywhere. This is the trade for
   * having no foreign keys on the pin columns (house style, see the schema comment).
   */
  async remove(id: string): Promise<void> {
    const row = await this.getOrThrow(id);
    const models = await this.prisma.aiModel.findMany({ where: { providerId: id }, select: { id: true } });
    await this.prisma.$transaction([
      ...this.models.clearPins(row.workspaceId, models.map((m) => m.id)),
      this.prisma.aiProvider.delete({ where: { id } }),
    ]);
    this.models.invalidate(row.workspaceId);
  }

  /** A profile the workspace does not own is left alone: the caller was authorized for `workspaceId`, not for the id (#789). */
  async recordCheck(workspaceId: string, id: string, ok: boolean, error?: string): Promise<void> {
    await this.prisma.aiProvider.updateMany({
      where: { id, workspaceId },
      data: {
        lastStatus: ok ? 'ok' : 'error',
        lastError: ok ? null : (error?.slice(0, 500) ?? 'unknown error'),
        lastCheckedAt: new Date(),
      },
    });
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
      hasApiKey: row.apiKeyCipher !== null,
      apiKeyHint: key ? maskSecret(key) : null,
      temperature: row.temperature,
      maxToolCalls: row.maxToolCalls,
      timeoutMs: row.timeoutMs,
      enabled: row.enabled,
      status: (row.lastStatus as AiProviderSummary['status']) ?? 'unknown',
      lastError: row.lastError,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
