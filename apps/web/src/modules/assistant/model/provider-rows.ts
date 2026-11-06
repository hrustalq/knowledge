/**
 * One row shape for the provider list on /settings/ai/config.
 *
 * The default config (`ai_settings` over the ASSISTANT_* env) and the named
 * providers (`ai_providers`) are two tables with different rules, but one question
 * for the reader: is this connection on, what does it serve, for which work, at
 * what price. Answering it here keeps the row a single template.
 *
 * Which work a model serves is worked out the way `AiConfigService.resolveFor`
 * does it: a route at a removed model or one whose provider is off falls through
 * to the default's own model, and only `decision` has no fallback (an unrouted
 * decision is off).
 */
import { effectiveModelPrice, PROVIDER_DEFAULTS } from '@knowledge/contracts'
import type {
  AiModelSummary,
  AiProvider,
  AiProviderStatus,
  AiProviderSummary,
  AiPurpose,
  AiSettingsResponse,
  ModelPrice,
} from '@knowledge/contracts'

export const DEFAULT_ROW_ID = 'default'
/** The default config's own model has no row of its own: it answers for "no route". */
export const IMPLICIT_MODEL_ID = 'implicit'

/** What the provider dialog is opened on. */
export type ProviderDialogTarget = { kind: 'new' } | { kind: 'default' } | { kind: 'profile'; provider: AiProviderSummary }

const FALLBACK_PURPOSES = ['chat', 'review', 'extraction'] as const satisfies readonly AiPurpose[]

/** Where a row's credential comes from; a profile with none borrows the default's. */
export type ProviderKeyState =
  | { source: 'stored'; hint: string | null }
  | { source: 'environment' }
  | { source: 'default' }
  | { source: 'missing' }

export interface ModelRow {
  id: string
  code: string
  price: ModelPrice | null
  serves: AiPurpose[]
  /** Null on the default config's own model, which is edited with its provider. */
  model: AiModelSummary | null
}

export interface ProviderRow {
  id: string
  isDefault: boolean
  /** A provider's own name; null on the default row, which is named by its kind. */
  name: string | null
  kind: AiProvider
  host: string | null
  key: ProviderKeyState
  models: ModelRow[]
  enabled: boolean
  /** The default row's nothing-is-overridden state; always false on a named provider. */
  fromEnvironment: boolean
  status: AiProviderStatus
  error: string | null
  checkedAt: string | null
}

/** The endpoint a row actually dials, as a hostname: its own, else the kind's default. */
export function providerHost(baseUrl: string | null | undefined, kind: AiProvider): string | null {
  const url = baseUrl || PROVIDER_DEFAULTS[kind]?.baseUrl
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function servedBy(settings: AiSettingsResponse, models: AiModelSummary[]): Map<string, AiPurpose[]> {
  const available = new Set(models.filter((m) => m.available).map((m) => m.id))
  const out = new Map<string, AiPurpose[]>()
  const add = (id: string, purpose: AiPurpose) => out.set(id, [...(out.get(id) ?? []), purpose])

  for (const purpose of FALLBACK_PURPOSES) {
    const routed = settings.routing[purpose]
    if (routed && available.has(routed)) add(routed, purpose)
    // With provider `none` the fallback is real but runs nothing, so it claims nothing.
    else if (settings.provider !== 'none') add(IMPLICIT_MODEL_ID, purpose)
  }
  const decision = settings.routing.decision
  if (decision && available.has(decision) && settings.decision.available) add(decision, 'decision')
  return out
}

/** The default first, always, then the named providers in the order the API lists them. */
export function buildProviderRows(
  settings: AiSettingsResponse,
  providers: AiProviderSummary[],
  models: AiModelSummary[],
): ProviderRow[] {
  const serves = servedBy(settings, models)
  const { sources } = settings
  const fromEnvironment =
    sources.provider === 'env' &&
    sources.baseUrl === 'env' &&
    sources.model === 'env' &&
    sources.apiKey === 'env' &&
    settings.pricePromptPerMTok === null &&
    settings.priceCompletionPerMTok === null &&
    settings.priceCachedPerMTok === null

  const rowsOf = (providerId: string | null): ModelRow[] =>
    models
      .filter((m) => m.providerId === providerId)
      .map((m) => ({ id: m.id, code: m.code, price: effectiveModelPrice(m.code, m), serves: serves.get(m.id) ?? [], model: m }))

  const defaultRow: ProviderRow = {
    id: DEFAULT_ROW_ID,
    isDefault: true,
    name: null,
    kind: settings.provider,
    host: settings.provider === 'none' ? null : providerHost(settings.baseUrl, settings.provider),
    key: !settings.hasApiKey
      ? { source: 'missing' }
      : sources.apiKey === 'db'
        ? { source: 'stored', hint: settings.apiKeyHint }
        : { source: 'environment' },
    models:
      settings.provider === 'none'
        ? rowsOf(null)
        : [
            {
              id: IMPLICIT_MODEL_ID,
              code: settings.model,
              price: effectiveModelPrice(settings.model, settings),
              serves: serves.get(IMPLICIT_MODEL_ID) ?? [],
              model: null,
            },
            ...rowsOf(null),
          ],
    enabled: settings.provider !== 'none',
    fromEnvironment,
    status: 'unknown',
    error: null,
    checkedAt: null,
  }

  return [
    defaultRow,
    ...providers.map(
      (p): ProviderRow => ({
        id: p.id,
        isDefault: false,
        name: p.name,
        kind: p.provider,
        host: providerHost(p.baseUrl, p.provider),
        key: p.hasApiKey ? { source: 'stored', hint: p.apiKeyHint } : { source: 'default' },
        models: rowsOf(p.id),
        enabled: p.enabled,
        fromEnvironment: false,
        status: p.status,
        error: p.status === 'error' ? p.lastError : null,
        checkedAt: p.lastCheckedAt,
      }),
    ),
  ]
}

export interface ModelGroup {
  /** Null is the default config, which the caller names. */
  providerName: string | null
  models: AiModelSummary[]
}

/**
 * The models a picker offers, grouped by who serves them, default first. A provider
 * that is off hides its models, except the one `selected` names: a select showing
 * nothing would hide the pin it is holding, so the caller shows that one disabled.
 */
export function groupModels(models: AiModelSummary[], selected?: string | null): ModelGroup[] {
  const groups = new Map<string | null, ModelGroup>()
  for (const model of models) {
    if (!model.available && model.id !== selected) continue
    const group = groups.get(model.providerId) ?? { providerName: model.providerName, models: [] }
    group.models.push(model)
    groups.set(model.providerId, group)
  }
  return [...groups.values()].sort((a, b) => (a.providerName ?? '').localeCompare(b.providerName ?? ''))
}

/** "" → null (no price set); a number → that number; anything else → undefined (invalid). */
export function parsePrice(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
