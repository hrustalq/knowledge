import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiPurpose, AiSettingsSourceMap, WebAccessSettings } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiProvidersService } from './ai-providers.service.js';
import { SourcePolicyService } from './source-policy.service.js';
import { decryptSecret, parseKey } from './secret-box.js';

/**
 * Per-provider defaults so `provider=deepseek` works with nothing but an API
 * key. DeepSeek speaks the OpenAI wire protocol, so the official `openai` SDK
 * is the client for every provider (docs/features/09).
 *
 * Moved here from AssistantClient: the resolver is now the one place that
 * knows how a provider name becomes an endpoint.
 */
export const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  /**
   * gen-api.ru is an OpenAI-compatible aggregator (the shape OpenRouter has):
   * one credential, many upstream models addressed by id, on a dedicated
   * proxy subdomain rather than the marketing domain. `model` is therefore a
   * default rather than a constraint — `claude-sonnet-4-5`, `gemini-2-5-flash`
   * and the rest are all valid values for it.
   */
  'gen-api': { baseUrl: 'https://proxy.gen-api.ru/v1', model: 'gpt-4-1' },
};

/**
 * Rough USD-per-1M-token list prices, used only to put a number next to the
 * token counts. Overridable per workspace (ai_settings.price_*_per_mtok)
 * because this table will go stale and self-hosted models are free.
 */
const MODEL_PRICES: Record<string, { prompt: number; completion: number }> = {
  'deepseek-chat': { prompt: 0.27, completion: 1.1 },
  'deepseek-reasoner': { prompt: 0.55, completion: 2.19 },
  'gpt-4o': { prompt: 2.5, completion: 10 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4.1': { prompt: 2, completion: 8 },
  'gpt-4.1-mini': { prompt: 0.4, completion: 1.6 },
  // gen-api addresses the same models under its own ids.
  'gpt-4-1': { prompt: 2, completion: 8 },
  'claude-sonnet-4-5': { prompt: 3, completion: 15 },
  'claude-opus-4-5': { prompt: 5, completion: 25 },
};

/** Effective assistant configuration for one workspace: DB overrides ∪ env ∪ provider defaults. */
export interface ResolvedAiConfig {
  workspaceId: string;
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  /** Never leaves the API process — controllers get `hasApiKey` instead. */
  apiKey: string;
  temperature: number;
  maxToolCalls: number;
  timeoutMs: number;
  /**
   * Relation-extraction tuning (docs/features/12). Resolved here so the
   * extractor can take it per job: the factory's instance cache holds
   * connection identity only, and its env extractor is a process-wide
   * singleton that could not carry a per-workspace value at all.
   */
  extractionMinConfidence: number;
  extractionMaxChunks: number;
  agentModeEnabled: boolean;
  pricePromptPerMTok: number | null;
  priceCompletionPerMTok: number | null;
  /**
   * How much of the open web this workspace may reach (docs/features/25).
   * Clamped by the env ceiling, never inherited from it.
   */
  webAccess: WebAccessSettings;
  /** The named profile serving this call, when one is routed. */
  providerId: string | null;
  providerName: string | null;
  /** Which layer each field came from — drives the UI's "inherited from env" hints. */
  sources: AiSettingsSourceMap;
}

/** How long a resolved config is reused before the DB is consulted again. */
const CACHE_TTL_MS = 30_000;

/**
 * Resolves the assistant configuration for a workspace.
 *
 * Before feature 12 this lived in AssistantClient's constructor, which meant a
 * model change needed a restart. Now every LLM entry point resolves per call:
 * the DB row wins field by field, and any null column falls through to the
 * ASSISTANT_* env var, then to PROVIDER_DEFAULTS. An empty ai_settings table
 * therefore reproduces the old behaviour exactly.
 *
 * Cached for CACHE_TTL_MS per workspace and invalidated on write. On a
 * multi-instance deployment a change can take up to one TTL to reach every
 * node; that is the deliberate cost of not hitting PG on every token.
 */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);
  private readonly cache = new Map<string, { at: number; config: ResolvedAiConfig }>();
  private readonly key: Buffer | null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly providers: AiProvidersService,
    private readonly sourcePolicies: SourcePolicyService,
  ) {
    this.key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    if (!this.key) {
      this.logger.warn('SETTINGS_ENCRYPTION_KEY is not set — provider credentials cannot be saved from the UI');
    }
  }

  /** True when secrets can be written at all (surfaced to the settings UI). */
  get canStoreSecrets(): boolean {
    return this.key !== null;
  }

  get encryptionKey(): Buffer | null {
    return this.key;
  }

  async resolve(workspaceId: string): Promise<ResolvedAiConfig> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.config;

    const row = await this.prisma.aiSettings.findUnique({ where: { workspaceId } });

    const envProvider = this.config.get('ASSISTANT_PROVIDER', { infer: true });
    const provider = row?.provider ?? envProvider;
    const defaults = PROVIDER_DEFAULTS[provider];

    const envBaseUrl = this.config.get('ASSISTANT_BASE_URL', { infer: true });
    const envModel = this.config.get('ASSISTANT_MODEL', { infer: true });
    const envKey = this.config.get('ASSISTANT_API_KEY', { infer: true });
    // A row written under a rotated/absent key decrypts to null and falls back
    // to the env credential rather than taking the assistant down.
    const dbKey = decryptSecret(row?.apiKeyCipher, this.key);

    const model = row?.model || (row?.provider ? '' : envModel) || defaults?.model || '';
    const baseUrl = (row?.baseUrl || (row?.provider ? '' : envBaseUrl) || defaults?.baseUrl || '').replace(/\/$/, '');

    const config: ResolvedAiConfig = {
      workspaceId,
      enabled: provider !== 'none',
      provider,
      baseUrl,
      model,
      apiKey: dbKey ?? envKey,
      temperature: row?.temperature ?? 0.2,
      maxToolCalls: row?.maxToolCalls ?? this.config.get('ASSISTANT_MAX_TOOL_CALLS', { infer: true }),
      timeoutMs: row?.timeoutMs ?? this.config.get('ASSISTANT_TIMEOUT_MS', { infer: true }),
      // `??`, not `||`: an explicit 0 confidence is a real setting ("keep
      // everything the model returns") and must not fall through to the env.
      extractionMinConfidence:
        row?.extractionMinConfidence ?? this.config.get('EXTRACTOR_MIN_CONFIDENCE', { infer: true }),
      extractionMaxChunks: row?.extractionMaxChunks ?? this.config.get('EXTRACTOR_MAX_CHUNKS', { infer: true }),
      agentModeEnabled: row?.agentModeEnabled ?? true,
      webAccess: this.sourcePolicies.webAccess(row?.webAccessMode),
      pricePromptPerMTok: row?.pricePromptPerMTok ? Number(row.pricePromptPerMTok) : null,
      priceCompletionPerMTok: row?.priceCompletionPerMTok ? Number(row.priceCompletionPerMTok) : null,
      providerId: null,
      providerName: null,
      sources: {
        provider: row?.provider ? 'db' : 'env',
        baseUrl: row?.baseUrl ? 'db' : 'env',
        model: row?.model ? 'db' : 'env',
        apiKey: dbKey ? 'db' : 'env',
        temperature: row?.temperature != null ? 'db' : 'env',
        maxToolCalls: row?.maxToolCalls != null ? 'db' : 'env',
        timeoutMs: row?.timeoutMs != null ? 'db' : 'env',
        extractionMinConfidence: row?.extractionMinConfidence != null ? 'db' : 'env',
        extractionMaxChunks: row?.extractionMaxChunks != null ? 'db' : 'env',
        // Not `row ? 'db' : 'env'`: a workspace can ask for a mode the
        // deployment refuses, and the third value is the only honest report of
        // that. `webAccess()` works it out; the map just mirrors it.
        webAccessMode: this.sourcePolicies.webAccess(row?.webAccessMode).source,
      },
    };

    this.cache.set(workspaceId, { at: Date.now(), config });
    return config;
  }

  /**
   * The config for one purpose, honouring provider profiles.
   *
   * Resolution order, first hit wins:
   *   1. `pinnedProviderId` — the profile a member chose for their thread;
   *   2. the profile this workspace routes `purpose` at;
   *   3. the inline ai_settings config, then the ASSISTANT_* env vars.
   *
   * Step 3 is what keeps this backward compatible: a workspace that never
   * creates a profile resolves exactly as it did before profiles existed.
   * A pinned or routed profile that has since been disabled or deleted also
   * falls through to it rather than failing the turn.
   */
  async resolveFor(
    workspaceId: string,
    purpose: AiPurpose,
    pinnedProviderId?: string | null,
  ): Promise<ResolvedAiConfig> {
    const base = await this.resolve(workspaceId);

    const routedId = pinnedProviderId ?? (await this.routedProviderId(workspaceId, purpose));
    if (!routedId) return base;

    const resolved = await this.providers.resolveRow(routedId);
    // Belt and braces against a profile from another tenant: routing columns
    // and thread pins are plain uuids with no FK, so the workspace is checked
    // here rather than trusted.
    if (!resolved || resolved.row.workspaceId !== workspaceId) return base;

    const { row, apiKey } = resolved;
    const defaults = PROVIDER_DEFAULTS[row.provider];
    return {
      ...base,
      enabled: row.provider !== 'none',
      provider: row.provider,
      baseUrl: (row.baseUrl || defaults?.baseUrl || '').replace(/\/$/, ''),
      model: row.model || defaults?.model || '',
      apiKey: apiKey ?? base.apiKey,
      temperature: row.temperature ?? base.temperature,
      maxToolCalls: row.maxToolCalls ?? base.maxToolCalls,
      timeoutMs: row.timeoutMs ?? base.timeoutMs,
      pricePromptPerMTok: row.pricePromptPerMTok ? Number(row.pricePromptPerMTok) : null,
      priceCompletionPerMTok: row.priceCompletionPerMTok ? Number(row.priceCompletionPerMTok) : null,
      providerId: row.id,
      providerName: row.name,
    };
  }

  private async routedProviderId(workspaceId: string, purpose: AiPurpose): Promise<string | null> {
    const row = await this.prisma.aiSettings.findUnique({
      where: { workspaceId },
      select: { chatProviderId: true, reviewProviderId: true, extractionProviderId: true },
    });
    if (!row) return null;
    return purpose === 'chat'
      ? row.chatProviderId
      : purpose === 'review'
        ? row.reviewProviderId
        : row.extractionProviderId;
  }

  /** Called by every write to ai_settings so the next resolve() sees it immediately. */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  /**
   * Estimated cost in USD micros (1e-6 USD) for one call. Returns null when no
   * price is known for the model, so the UI can show "—" rather than a
   * confident $0.00 for a self-hosted or unlisted model.
   */
  estimateCostMicros(config: ResolvedAiConfig, promptTokens: number, completionTokens: number): number | null {
    const listed = MODEL_PRICES[config.model];
    const prompt = config.pricePromptPerMTok ?? listed?.prompt;
    const completion = config.priceCompletionPerMTok ?? listed?.completion;
    if (prompt == null || completion == null) return null;
    const usd = (promptTokens / 1_000_000) * prompt + (completionTokens / 1_000_000) * completion;
    return Math.round(usd * 1_000_000);
  }
}
