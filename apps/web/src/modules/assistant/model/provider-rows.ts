/**
 * One row shape for the provider list on /settings/ai/config.
 *
 * The default config (`ai_settings` over the ASSISTANT_* env) and the named
 * profiles (`ai_providers`) are two tables with different rules, but one
 * question for the reader: what does this provider run, on what, for which work,
 * at what price. Answering it here keeps the row a single template.
 *
 * Which work a row serves is worked out the way `AiConfigService.resolveFor`
 * does it: a route at a disabled or deleted profile falls through to the default,
 * and only `decision` has no fallback (an unrouted decision is off).
 */
import { effectiveModelPrice, PROVIDER_DEFAULTS } from '@knowledge/contracts'
import type {
  AiProvider,
  AiProviderStatus,
  AiProviderSummary,
  AiPurpose,
  AiSettingsResponse,
  ModelPrice,
} from '@knowledge/contracts'

export const DEFAULT_ROW_ID = 'default'

/** What the provider dialog is opened on. */
export type ProviderDialogTarget = { kind: 'new' } | { kind: 'default' } | { kind: 'profile'; provider: AiProviderSummary }

const FALLBACK_PURPOSES = ['chat', 'review', 'extraction'] as const satisfies readonly AiPurpose[]

/** Where a row's credential comes from; a profile with none borrows the default's. */
export type ProviderKeyState =
  | { source: 'stored'; hint: string | null }
  | { source: 'environment' }
  | { source: 'default' }
  | { source: 'missing' }

export interface ProviderRow {
  id: string
  isDefault: boolean
  /** A profile's own name; null on the default row, which is named by its kind. */
  name: string | null
  kind: AiProvider
  model: string
  host: string | null
  key: ProviderKeyState
  price: ModelPrice | null
  serves: AiPurpose[]
  enabled: boolean
  /** The default row's nothing-is-overridden state; always false on a profile. */
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

function servedBy(settings: AiSettingsResponse, providers: AiProviderSummary[]): Map<string, AiPurpose[]> {
  const enabled = new Set(providers.filter((p) => p.enabled).map((p) => p.id))
  const out = new Map<string, AiPurpose[]>()
  const add = (id: string, purpose: AiPurpose) => out.set(id, [...(out.get(id) ?? []), purpose])

  for (const purpose of FALLBACK_PURPOSES) {
    const routed = settings.routing[purpose]
    if (routed && enabled.has(routed)) add(routed, purpose)
    // With provider `none` the fallback is real but runs nothing, so it claims nothing.
    else if (settings.provider !== 'none') add(DEFAULT_ROW_ID, purpose)
  }
  const decision = settings.routing.decision
  if (decision && enabled.has(decision) && settings.decision.available) add(decision, 'decision')
  return out
}

/** The default first, always, then the profiles in the order the API lists them. */
export function buildProviderRows(settings: AiSettingsResponse, providers: AiProviderSummary[]): ProviderRow[] {
  const serves = servedBy(settings, providers)
  const { sources } = settings
  const fromEnvironment =
    sources.provider === 'env' &&
    sources.baseUrl === 'env' &&
    sources.model === 'env' &&
    sources.apiKey === 'env' &&
    settings.pricePromptPerMTok === null &&
    settings.priceCompletionPerMTok === null

  const defaultRow: ProviderRow = {
    id: DEFAULT_ROW_ID,
    isDefault: true,
    name: null,
    kind: settings.provider,
    model: settings.model,
    host: settings.provider === 'none' ? null : providerHost(settings.baseUrl, settings.provider),
    key: !settings.hasApiKey
      ? { source: 'missing' }
      : sources.apiKey === 'db'
        ? { source: 'stored', hint: settings.apiKeyHint }
        : { source: 'environment' },
    price: effectiveModelPrice(settings.model, settings.pricePromptPerMTok, settings.priceCompletionPerMTok),
    serves: serves.get(DEFAULT_ROW_ID) ?? [],
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
        model: p.model,
        host: providerHost(p.baseUrl, p.provider),
        key: p.hasApiKey ? { source: 'stored', hint: p.apiKeyHint } : { source: 'default' },
        price: effectiveModelPrice(p.model, p.pricePromptPerMTok, p.priceCompletionPerMTok),
        serves: serves.get(p.id) ?? [],
        enabled: p.enabled,
        fromEnvironment: false,
        status: p.status,
        error: p.status === 'error' ? p.lastError : null,
        checkedAt: p.lastCheckedAt,
      }),
    ),
  ]
}

/** "" → null (no price set); a number → that number; anything else → undefined (invalid). */
export function parsePrice(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
