import { describe, expect, it } from 'vitest'
import type { AiModelSummary, AiProviderSummary, AiSettingsResponse } from '@knowledge/contracts'
import {
  buildProviderRows,
  DEFAULT_ROW_ID,
  groupModels,
  IMPLICIT_MODEL_ID,
  parsePrice,
  providerHost,
  type ProviderRow,
} from './provider-rows'

/**
 * The provider list's one row shape.
 *
 * 1. **The default row is always first**, and the fallback is the resolver's: a
 *    route at a model whose provider is off lands on the default's own model.
 * 2. **`decision` never falls back** — unrouted is off, and off for the
 *    deployment claims nothing either.
 * 3. **A price is the same rule the usage row is written under.**
 */

const env = { provider: 'env', baseUrl: 'env', model: 'env', apiKey: 'env' }

function settings(over: Partial<AiSettingsResponse> = {}): AiSettingsResponse {
  return {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'gpt-4o',
    hasApiKey: true,
    apiKeyHint: null,
    pricePromptPerMTok: null,
    priceCompletionPerMTok: null,
    priceCachedPerMTok: null,
    priceCurrency: null,
    sources: env,
    routing: { chat: null, review: null, extraction: null, decision: null },
    decision: { available: true },
    ...over,
  } as unknown as AiSettingsResponse
}

function profile(over: Partial<AiProviderSummary> = {}): AiProviderSummary {
  return {
    id: 'p1',
    name: 'Luna',
    provider: 'gen-api',
    baseUrl: null,
    hasApiKey: false,
    apiKeyHint: null,
    enabled: true,
    status: 'unknown',
    lastError: 'stale',
    lastCheckedAt: null,
    ...over,
  } as AiProviderSummary
}

function model(over: Partial<AiModelSummary> = {}): AiModelSummary {
  return {
    id: 'm1',
    providerId: 'p1',
    providerName: 'Luna',
    code: 'gpt-6-luna',
    source: 'manual',
    inChat: true,
    available: true,
    kind: 'gen-api',
    pricePromptPerMTok: null,
    priceCompletionPerMTok: null,
    priceCachedPerMTok: null,
    priceCurrency: null,
    capabilities: null,
    ...over,
  } as AiModelSummary
}

const served = (row: ProviderRow | undefined, id: string) => row!.models.find((m) => m.id === id)!.serves

describe('buildProviderRows', () => {
  it('puts the default first, serving every unrouted purpose on its own model', () => {
    const [first, second] = buildProviderRows(settings(), [profile()], [model()])
    expect(first).toMatchObject({ id: DEFAULT_ROW_ID, isDefault: true, fromEnvironment: true })
    expect(served(first, IMPLICIT_MODEL_ID)).toEqual(['chat', 'review', 'extraction'])
    expect(served(second, 'm1')).toEqual([])
  })

  it('moves a routed purpose onto the model', () => {
    const rows = buildProviderRows(settings({ routing: { chat: 'm1', review: null, extraction: null, decision: null } }), [profile()], [model()])
    expect(served(rows[0], IMPLICIT_MODEL_ID)).toEqual(['review', 'extraction'])
    expect(served(rows[1], 'm1')).toEqual(['chat'])
  })

  it('sends a route at a removed model or an off provider back to the default, as the resolver does', () => {
    const routing = { chat: 'm1', review: 'gone', extraction: null, decision: null }
    const rows = buildProviderRows(settings({ routing }), [profile({ enabled: false })], [model({ available: false })])
    expect(served(rows[0], IMPLICIT_MODEL_ID)).toEqual(['chat', 'review', 'extraction'])
    expect(served(rows[1], 'm1')).toEqual([])
  })

  it('lists a model of the default config under the default row, after its own', () => {
    const [first] = buildProviderRows(settings(), [], [model({ id: 'm2', providerId: null, providerName: null, code: 'gpt-4o-mini' })])
    expect(first!.models.map((m) => m.code)).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(first!.models[0]!.model).toBeNull()
  })

  it('never falls a decision back to the default', () => {
    const routing = { chat: null, review: null, extraction: null, decision: 'm1' }
    expect(served(buildProviderRows(settings({ routing }), [profile()], [model()])[1], 'm1')).toEqual(['decision'])
    const off = settings({ routing, decision: { available: false } } as never)
    expect(served(buildProviderRows(off, [profile()], [model()])[1], 'm1')).toEqual([])
    expect(served(buildProviderRows(settings(), [], [])[0], IMPLICIT_MODEL_ID)).not.toContain('decision')
  })

  it('claims no work for a default of none', () => {
    const [row] = buildProviderRows(settings({ provider: 'none', hasApiKey: false, model: '' }), [], [])
    expect(row).toMatchObject({ enabled: false, models: [], host: null, key: { source: 'missing' } })
  })

  it('says where a key comes from', () => {
    const stored = settings({ sources: { ...env, apiKey: 'db' }, apiKeyHint: '…1234' } as never)
    expect(buildProviderRows(stored, [], [])[0]!.key).toEqual({ source: 'stored', hint: '…1234' })
    expect(buildProviderRows(settings(), [], [])[0]!.key).toEqual({ source: 'environment' })
    expect(buildProviderRows(settings(), [profile()], [])[1]!.key).toEqual({ source: 'default' })
  })

  it('prices a model by the usage rule: list, override, or nothing', () => {
    const rows = buildProviderRows(settings(), [profile()], [
      model(),
      model({ id: 'm2', pricePromptPerMTok: 1, priceCompletionPerMTok: 2 }),
      model({ id: 'm3', pricePromptPerMTok: 1 }),
    ])
    expect(rows[0]!.models[0]!.price).toEqual({ prompt: 2.5, cachedPrompt: 1.25, completion: 10, currency: 'USD', custom: false })
    expect(rows[1]!.models.map((m) => m.price)).toEqual([
      null,
      { prompt: 1, cachedPrompt: null, completion: 2, currency: 'USD', custom: true },
      null,
    ])
  })

  it('keeps a stale error off a provider that is not failing', () => {
    const rows = buildProviderRows(settings(), [profile(), profile({ id: 'p2', status: 'error', lastError: 'boom' })], [])
    expect(rows[1]!.error).toBeNull()
    expect(rows[2]!.error).toBe('boom')
  })

  it('states the currency a model is priced in', () => {
    const rubles = { pricePromptPerMTok: 300, priceCompletionPerMTok: 900, priceCurrency: 'RUB' as const }
    expect(buildProviderRows(settings(), [profile()], [model(rubles)])[1]!.models[0]!.price).toMatchObject({ prompt: 300, currency: 'RUB' })
  })

  it('stops calling the default environment-only once a price is set', () => {
    expect(buildProviderRows(settings({ pricePromptPerMTok: 1 }), [], [])[0]!.fromEnvironment).toBe(false)
  })
})

describe('groupModels', () => {
  const luna = model()
  const off = model({ id: 'm2', providerId: 'p2', providerName: 'Off', available: false })
  const own = model({ id: 'm3', providerId: null, providerName: null })

  it('groups by who serves them, the default first, and hides what is off', () => {
    expect(groupModels([luna, off, own]).map((g) => g.providerName)).toEqual([null, 'Luna'])
  })

  it('keeps the one pin it is holding, so a select does not go blank', () => {
    expect(groupModels([luna, off], 'm2').map((g) => g.providerName)).toEqual(['Luna', 'Off'])
  })
})

describe('providerHost', () => {
  it('names the endpoint a row dials, falling back to the kind', () => {
    expect(providerHost('http://localhost:11434/v1', 'openai-compatible')).toBe('localhost:11434')
    expect(providerHost(null, 'gen-api')).toBe('proxy.gen-api.ru')
    expect(providerHost('', 'openai-compatible')).toBeNull()
    expect(providerHost('not a url', 'openai-compatible')).toBe('not a url')
  })
})

describe('parsePrice', () => {
  it('tells empty from invalid, so a typo never saves as "no price"', () => {
    expect(parsePrice('  ')).toBeNull()
    expect(parsePrice('0')).toBe(0)
    expect(parsePrice('1,10')).toBe(1.1)
    expect(parsePrice('abc')).toBeUndefined()
    expect(parsePrice('-1')).toBeUndefined()
  })
})
