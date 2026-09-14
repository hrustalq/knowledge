import { BadRequestException, Injectable } from '@nestjs/common';
import type { AiConnectionTestResponse, AiProvider, AiSettingsResponse, WebAccessMode } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AiConfigService } from './ai-config.service.js';
import { SourcePolicyService } from './source-policy.service.js';
import { encryptSecret, maskSecret, MissingEncryptionKeyError } from './secret-box.js';
import { t } from '../i18n/t.js';
import { currentLocale } from '../i18n/locale.js';

export interface UpdateAiSettingsInput {
  /** Per-purpose routing; null clears a route back to the inline config. */
  chatProviderId?: string | null;
  reviewProviderId?: string | null;
  extractionProviderId?: string | null;
  provider?: AiProvider | null;
  baseUrl?: string | null;
  model?: string | null;
  /** Plaintext, write-only: `undefined` keeps the stored key, `null`/`''` clears it. */
  apiKey?: string | null;
  temperature?: number | null;
  maxToolCalls?: number | null;
  timeoutMs?: number | null;
  /** Relation-extraction tuning; null clears the override back to EXTRACTOR_*. */
  extractionMinConfidence?: number | null;
  extractionMaxChunks?: number | null;
  agentModeEnabled?: boolean;
  /** docs/features/25 — null clears the override and inherits the env ceiling. */
  webAccessMode?: WebAccessMode | null;
  pricePromptPerMTok?: number | null;
  priceCompletionPerMTok?: number | null;
  workspaceMonthlyTokenBudget?: number | null;
  defaultUserMonthlyTokenBudget?: number | null;
  enforceBudget?: boolean;
}

/**
 * Read/write side of the per-workspace assistant configuration
 * (docs/features/12). AiConfigService is the read path used at request time;
 * this is the admin surface, and the only place that writes credentials.
 *
 * The provider credential is write-only by construction: it goes in as
 * plaintext, comes back as `hasApiKey` plus a last-4 hint, and is never
 * returned in full by any endpoint.
 */
@Injectable()
export class AiSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly sourcePolicies: SourcePolicyService,
    private readonly client: AssistantClient,
  ) {}

  async get(workspaceId: string): Promise<AiSettingsResponse> {
    const [row, effective] = await Promise.all([
      this.prisma.aiSettings.findUnique({ where: { workspaceId } }),
      this.aiConfig.resolve(workspaceId),
    ]);
    return {
      workspaceId,
      provider: effective.provider as AiProvider,
      baseUrl: effective.baseUrl,
      model: effective.model,
      hasApiKey: effective.apiKey !== '',
      apiKeyHint: effective.sources.apiKey === 'db' ? maskSecret(effective.apiKey) : null,
      temperature: effective.temperature,
      maxToolCalls: effective.maxToolCalls,
      timeoutMs: effective.timeoutMs,
      extractionMinConfidence: effective.extractionMinConfidence,
      extractionMaxChunks: effective.extractionMaxChunks,
      agentModeEnabled: effective.agentModeEnabled,
      webAccess: effective.webAccess,
      pricePromptPerMTok: effective.pricePromptPerMTok,
      priceCompletionPerMTok: effective.priceCompletionPerMTok,
      workspaceMonthlyTokenBudget:
        row?.workspaceMonthlyTokenBudget == null ? null : Number(row.workspaceMonthlyTokenBudget),
      defaultUserMonthlyTokenBudget:
        row?.defaultUserMonthlyTokenBudget == null ? null : Number(row.defaultUserMonthlyTokenBudget),
      enforceBudget: row?.enforceBudget ?? false,
      sources: effective.sources,
      routing: {
        chat: row?.chatProviderId ?? null,
        review: row?.reviewProviderId ?? null,
        extraction: row?.extractionProviderId ?? null,
      },
      canStoreSecrets: this.aiConfig.canStoreSecrets,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async update(workspaceId: string, input: UpdateAiSettingsInput, actorId?: string): Promise<AiSettingsResponse> {
    // `allowlist` with nothing on the list is a web search that silently
    // returns nothing, which reads as broken rather than as configured — so it
    // is refused at the save, the shape of the agent scheduler refusing to
    // enable without an owner and an interval.
    if (input.webAccessMode !== undefined) {
      await this.sourcePolicies.assertModeSavable(workspaceId, input.webAccessMode);
    }
    const data = {
      ...pick(input, 'provider'),
      ...pick(input, 'baseUrl'),
      ...pick(input, 'model'),
      ...pick(input, 'temperature'),
      ...pick(input, 'maxToolCalls'),
      ...pick(input, 'timeoutMs'),
      ...pick(input, 'extractionMinConfidence'),
      ...pick(input, 'extractionMaxChunks'),
      ...pick(input, 'pricePromptPerMTok'),
      ...pick(input, 'priceCompletionPerMTok'),
      ...pick(input, 'workspaceMonthlyTokenBudget'),
      ...pick(input, 'defaultUserMonthlyTokenBudget'),
      ...pick(input, 'chatProviderId'),
      ...pick(input, 'reviewProviderId'),
      ...pick(input, 'extractionProviderId'),
      ...(input.agentModeEnabled === undefined ? {} : { agentModeEnabled: input.agentModeEnabled }),
      ...pick(input, 'webAccessMode'),
      ...(input.enforceBudget === undefined ? {} : { enforceBudget: input.enforceBudget }),
      ...(input.apiKey === undefined ? {} : { apiKeyCipher: this.encryptKey(input.apiKey) }),
      updatedBy: actorId ?? null,
    };

    await this.prisma.aiSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    // The next request must see the change, not a cached config up to a TTL old.
    this.aiConfig.invalidate(workspaceId);
    return this.get(workspaceId);
  }

  /**
   * One tiny completion against the effective config. This is the button that
   * turns "I typed a key" into "the key works", so it reports the upstream
   * message rather than the generic 503 the assistant paths raise.
   */
  async test(workspaceId: string, principalId: string, providerId?: string): Promise<AiConnectionTestResponse> {
    // Test whatever chat would actually use, profile routing included —
    // testing the inline config while chat runs on a profile would be a green
    // tick for a path nobody takes.
    const config = providerId
      ? await this.aiConfig.resolveFor(workspaceId, 'chat', providerId)
      : await this.aiConfig.resolveFor(workspaceId, 'chat');
    if (!config.enabled) {
      return { ok: false, model: '', latencyMs: 0, error: t('error.ai.providerNone') };
    }
    const startedAt = Date.now();
    try {
      await this.client.chat({ config, userId: principalId, operation: 'suggest', locale: currentLocale() }, [
        { role: 'user', content: 'Reply with the single word: ok' },
      ]);
      return { ok: true, model: config.model, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        model: config.model,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private encryptKey(apiKey: string | null): string | null {
    if (apiKey === null || apiKey === '') return null; // explicit clear
    try {
      return encryptSecret(apiKey, this.aiConfig.encryptionKey);
    } catch (err) {
      if (err instanceof MissingEncryptionKeyError) {
        throw new BadRequestException(
          t('error.ai.encryptionKeyMissing'),
        );
      }
      throw err;
    }
  }
}

/**
 * Copies a field only when the caller sent it. `undefined` means "leave alone"
 * and `null` means "clear the override, inherit env again" — a distinction the
 * whole settings model depends on, so it is never collapsed.
 */
function pick<K extends keyof UpdateAiSettingsInput>(
  input: UpdateAiSettingsInput,
  key: K,
): Partial<Record<K, UpdateAiSettingsInput[K]>> {
  return input[key] === undefined ? {} : ({ [key]: input[key] } as Partial<Record<K, UpdateAiSettingsInput[K]>>);
}
