import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { effectiveModelPrice, PROVIDER_DEFAULTS, type CostAmount, type CostCurrency } from '@knowledge/contracts';
import type {
  AiPurpose,
  AiSettingsSourceMap,
  CaptureSettings,
  DecisionSettings,
  ExternalAiActionsSettings,
  WebAccessSettings,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiProvidersService } from './ai-providers.service.js';
import { AiModelsService, modelAvailable, modelPrices, type AiModelRow } from './ai-models.service.js';
import { SourcePolicyService } from './source-policy.service.js';
import { decryptSecret, parseKey, secretStatus } from './secret-box.js';
import { slots } from './secret-slots.js';
import { resolveExternalAiActions } from './external-ai-actions.js';
import { resolveCaptureSettings } from './capture-settings.js';
import { resolveDecisionSettings } from './decision-settings.js';
import { ttlCache } from '../common/ttl-cache.js';
import { endpointOf } from './provider-endpoint.js';

/** Effective assistant configuration for one workspace: DB overrides ∪ env ∪ provider defaults. */
export interface ResolvedAiConfig {
  workspaceId: string;
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  /** Never leaves the API process — controllers get `hasApiKey` instead. */
  apiKey: string;
  /**
   * A key is stored for this connection but no longer decrypts (another
   * SETTINGS_ENCRYPTION_KEY, an envelope moved from another row), #1106. The
   * connection then has no key: it does not fall back to the env credential.
   */
  apiKeyUnreadable?: boolean;
  /**
   * Whether `baseUrl` may resolve to a private address: true for the operator's
   * ASSISTANT_BASE_URL endpoint, and for a workspace's own base URL only under
   * AI_PROVIDERS_ALLOW_PRIVATE_URLS (GHSA-7hf4-5chc-29gr). Every dialer passes
   * it to `safeFetch`.
   */
  privateOk: boolean;
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
  priceCachedPerMTok: number | null;
  priceCurrency: CostCurrency | null;
  /**
   * How much of the open web this workspace may reach (docs/features/25).
   * Clamped by the env ceiling, never inherited from it.
   */
  webAccess: WebAccessSettings;
  /** Whether the page AI actions menu may open external vendors (issue #68). */
  externalAiActions: ExternalAiActionsSettings;
  /** The named provider serving this call, when one does. Null on the default config. */
  providerId: string | null;
  providerName: string | null;
  /** The `ai_models` row serving this call, when a pin or a route chose one. */
  modelId: string | null;
  /** That row's declared capabilities, overriding the model table (model-capabilities.ts). */
  capabilities: unknown;
  /** Which layer each field came from — drives the UI's "inherited from env" hints. */
  sources: AiSettingsSourceMap;
}

/** One ai_settings read: the resolved config, and the model each purpose is routed at. */
type WorkspaceAi = { config: ResolvedAiConfig; routes: Record<AiPurpose, string | null> };

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
 * Cached for CACHE_TTL_MS per workspace (the config and the purpose routes,
 * from the one ai_settings read) and invalidated on write. On a
 * multi-instance deployment a change can take up to one TTL to reach every
 * node; that is the deliberate cost of not hitting PG on every token.
 */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);
  private readonly cache = ttlCache<WorkspaceAi>(CACHE_TTL_MS);
  private readonly key: Buffer | null;
  private readonly allowPrivate: boolean;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly providers: AiProvidersService,
    private readonly models: AiModelsService,
    private readonly sourcePolicies: SourcePolicyService,
  ) {
    this.key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = this.config.get('AI_PROVIDERS_ALLOW_PRIVATE_URLS', { infer: true });
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
    return (await this.settings(workspaceId)).config;
  }

  private settings(workspaceId: string) {
    return this.cache.get(workspaceId, () => this.load(workspaceId));
  }

  private async load(workspaceId: string): Promise<WorkspaceAi> {
    const row = await this.prisma.aiSettings.findUnique({ where: { workspaceId } });

    const envProvider = this.config.get('ASSISTANT_PROVIDER', { infer: true });
    const provider = row?.provider ?? envProvider;
    const defaults = PROVIDER_DEFAULTS[provider];

    const envBaseUrl = this.config.get('ASSISTANT_BASE_URL', { infer: true });
    const envModel = this.config.get('ASSISTANT_MODEL', { infer: true });
    const envKey = this.config.get('ASSISTANT_API_KEY', { infer: true });
    // A stored key that no longer decrypts is reported, never replaced by the
    // env credential behind the admin's back (#1106).
    const keySlot = slots.aiSettingsKey(workspaceId);
    const dbKey = decryptSecret(row?.apiKeyCipher, this.key, keySlot);
    const apiKeyUnreadable = secretStatus(row?.apiKeyCipher, this.key, keySlot) === 'unreadable';

    const model = row?.model || (row?.provider ? '' : envModel) || defaults?.model || '';
    const baseUrl = (row?.baseUrl || (row?.provider ? '' : envBaseUrl) || defaults?.baseUrl || '').replace(/\/$/, '');
    // The env key is the operator's, for the operator's endpoint only
    // (GHSA-7hf4-5chc-29gr): a row that points anywhere else needs its own.
    const envEndpoint = endpointOf(envProvider, envBaseUrl);
    const onEnvEndpoint = baseUrl === envEndpoint;

    const externalAiActions = resolveExternalAiActions(
      row?.externalAiActions,
      this.config.get('AI_EXTERNAL_ACTIONS_ENABLED', { infer: true }),
    );

    const config: ResolvedAiConfig = {
      workspaceId,
      enabled: provider !== 'none',
      provider,
      baseUrl,
      model,
      apiKey: dbKey ?? (onEnvEndpoint && !apiKeyUnreadable ? envKey : ''),
      apiKeyUnreadable,
      privateOk: onEnvEndpoint || this.allowPrivate,
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
      externalAiActions,
      pricePromptPerMTok: row?.pricePromptPerMTok ? Number(row.pricePromptPerMTok) : null,
      priceCompletionPerMTok: row?.priceCompletionPerMTok ? Number(row.priceCompletionPerMTok) : null,
      priceCachedPerMTok: row?.priceCachedPerMTok ? Number(row.priceCachedPerMTok) : null,
      priceCurrency: (row?.priceCurrency as CostCurrency | null | undefined) ?? null,
      providerId: null,
      providerName: null,
      modelId: null,
      capabilities: null,
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
        externalAiActions: externalAiActions.source,
      },
    };

    const routes = {
      chat: row?.chatModelId ?? null,
      review: row?.reviewModelId ?? null,
      extraction: row?.extractionModelId ?? null,
      decision: row?.decisionModelId ?? null,
    };
    return { config, routes };
  }

  /**
   * A workspace's agent-session memory settings (issue #73), clamped by the
   * CAPTURE_* env block. Read uncached: it is asked once per capture, which
   * the same settings rate-limit, and a lowered limit must bite at once.
   */
  async captureSettings(workspaceId: string): Promise<CaptureSettings> {
    const row = await this.prisma.aiSettings.findUnique({ where: { workspaceId } });
    return resolveCaptureSettings(row, {
      enabled: this.config.get('CAPTURE_ENABLED', { infer: true }),
      perKeyPerHour: this.config.get('CAPTURE_PER_KEY_PER_HOUR', { infer: true }),
      perWorkspacePerDay: this.config.get('CAPTURE_PER_WORKSPACE_PER_DAY', { infer: true }),
      dedupeThreshold: this.config.get('CAPTURE_DEDUPE_THRESHOLD', { infer: true }),
      amendThreshold: this.config.get('CAPTURE_AMEND_THRESHOLD', { infer: true }),
    });
  }

  /**
   * A workspace's decision pre-filter thresholds (#530) and whether the
   * deployment allows decision calls at all. Read uncached, like
   * `captureSettings`: asked once per run, answer or harvest.
   */
  async decisionSettings(workspaceId: string): Promise<DecisionSettings> {
    const row = await this.prisma.aiSettings.findUnique({ where: { workspaceId } });
    return resolveDecisionSettings(row, this.config.get('DECISION_PROVIDER', { infer: true }) !== 'none');
  }

  /**
   * The config for one purpose, honouring pinned and routed models.
   *
   * Resolution order, first usable hit wins:
   *   1. `pins`, most specific first — a thread's model, then an agent's;
   *   2. the model this workspace routes `purpose` at;
   *   3. the inline ai_settings config, then the ASSISTANT_* env vars.
   *
   * Step 3 is what keeps this backward compatible: a workspace that never adds a
   * model resolves exactly as it did before models existed. A model that has
   * been removed, belongs to another workspace, or whose provider is off is
   * looked past rather than failing the turn, so turning a provider back on
   * restores every pin at it.
   */
  async resolveFor(
    workspaceId: string,
    purpose: AiPurpose,
    ...pins: Array<string | null | undefined>
  ): Promise<ResolvedAiConfig> {
    const { config: base, routes } = await this.settings(workspaceId);
    for (const id of [...pins, routes[purpose]]) {
      const config = id ? await this.forModel(base, id) : null;
      if (config) return config;
    }
    return base;
  }

  private async forModel(base: ResolvedAiConfig, id: string): Promise<ResolvedAiConfig | null> {
    const row = await this.models.find(base.workspaceId, id);
    if (!row) return null;
    const connection = row.providerId ? await this.forProvider(base, row.providerId) : base;
    if (!connection?.enabled) return null;
    return { ...connection, model: row.code, modelId: row.id, capabilities: row.capabilities, ...modelPrices(row) };
  }

  /** A named provider's connection and budget. It names no model: the caller's model does. */
  private async forProvider(base: ResolvedAiConfig, providerId: string): Promise<ResolvedAiConfig | null> {
    const resolved = await this.providers.resolveRow(providerId);
    // Belt and braces against a provider from another tenant.
    if (!resolved || resolved.row.workspaceId !== base.workspaceId) return null;
    const { row, apiKey, apiKeyUnreadable } = resolved;
    const defaults = PROVIDER_DEFAULTS[row.provider];
    const baseUrl = endpointOf(row.provider, row.baseUrl);
    // A key-less provider borrows the default config's key only when it dials
    // the same endpoint (GHSA-7hf4-5chc-29gr).
    const sameEndpoint = baseUrl === base.baseUrl;
    return {
      ...base,
      enabled: row.provider !== 'none',
      provider: row.provider,
      baseUrl,
      model: defaults?.model || '',
      apiKey: apiKey ?? (sameEndpoint && !apiKeyUnreadable ? base.apiKey : ''),
      apiKeyUnreadable,
      privateOk: sameEndpoint ? base.privateOk : this.allowPrivate,
      temperature: row.temperature ?? base.temperature,
      maxToolCalls: row.maxToolCalls ?? base.maxToolCalls,
      timeoutMs: row.timeoutMs ?? base.timeoutMs,
      pricePromptPerMTok: null,
      priceCompletionPerMTok: null,
      priceCachedPerMTok: null,
      priceCurrency: null,
      providerId: row.id,
      providerName: row.name,
    };
  }

  /**
   * What a provider's model list and Test dial: its endpoint and credential, with
   * the model it would test on. Null when it is off or not this workspace's.
   */
  async connection(workspaceId: string, providerId: string): Promise<ResolvedAiConfig | null> {
    const connection = await this.forProvider(await this.resolve(workspaceId), providerId);
    if (!connection) return null;
    const own = (await this.models.roster(workspaceId)).filter((m) => m.providerId === providerId);
    const model = own.find((m) => m.inChat) ?? own[0];
    return model ? { ...connection, model: model.code, modelId: model.id, ...modelPrices(model) } : connection;
  }

  /** Every model this workspace can call right now: a provider that is off hides all of its own. */
  async availableModels(workspaceId: string): Promise<AiModelRow[]> {
    const [base, rows] = await Promise.all([this.resolve(workspaceId), this.models.roster(workspaceId)]);
    return rows.filter((row) => modelAvailable(row, base.provider));
  }

  /**
   * A thread's pin, if members may still use it. "In chat" is checked on
   * execution as well as on offer: a thread outlives an admin's change.
   */
  async chatPin(workspaceId: string, modelId: string | null): Promise<string | null> {
    if (!modelId) return null;
    const rows = await this.models.roster(workspaceId);
    return rows.some((row) => row.id === modelId && row.inChat) ? modelId : null;
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
  estimateCost(config: ResolvedAiConfig, promptTokens: number, completionTokens: number, cachedPromptTokens = 0): CostAmount | null {
    const price = effectiveModelPrice(config.model, config);
    if (!price) return null;
    // `promptTokens` includes the cached ones, as every provider reports it.
    const cached = Math.min(cachedPromptTokens, promptTokens);
    const amount =
      ((promptTokens - cached) / 1_000_000) * price.prompt +
      (cached / 1_000_000) * (price.cachedPrompt ?? price.prompt) +
      (completionTokens / 1_000_000) * price.completion;
    return { micros: Math.round(amount * 1_000_000), currency: price.currency };
  }
}
