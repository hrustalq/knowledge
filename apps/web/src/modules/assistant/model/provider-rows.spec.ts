import { describe, expect, it } from 'vitest'
import type { AiProviderSummary, AiSettingsResponse } from '@knowledge/contracts'
import { buildProviderRows, DEFAULT_ROW_ID, parsePrice, providerHost } from './provider-rows'

/**
 * The provider list's one row shape.
 *
 * 1. **The default row is always first**, and the fallback is the resolver's:
 *    a route at a disabled profile lands on the default, not on the profile.
 * 2. **`decision` never falls back** — unrouted is off, and off for the
 *    deployment claims nothing either.
 * 3. **A price is the same rule the usage row is written under.**
 */

const env = { provider: 'env', baseUrl: 'env', model: 'env', apiKey: 'env' }

function settings(over: Partial<AiSettingsResponse> = {}): AiSettingsResponse {
  return {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    hasApiKey: true,
    apiKeyHint: null,
    pricePromptPerMTok: null,
    priceCompletionPerMTok: null,
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
    model: 'gpt-6-luna',
    hasApiKey: false,
    apiKeyHint: null,
    pricePromptPerMTok: null,
    priceCompletionPerMTok: null,
    enabled: true,
    status: 'unknown',
    lastError: 'stale',
    lastCheckedAt: null,
    ...over,
  } as AiProviderSummary
}

describe('buildProviderRows', () => {
  it('puts the default first and gives it every unrouted purpose', () => {
    const [first, second] = buildProviderRows(settings(), [profile()])
    expect(first).toMatchObject({ id: DEFAULT_ROW_ID, isDefault: true, fromEnvironment: true })
    expect(first!.serves).toEqual(['chat', 'review', 'extraction'])
    expect(second).toMatchObject({ id: 'p1', serves: [] })
  })

  it('moves a routed purpose onto the profile', () => {
    const rows = buildProviderRows(settings({ routing: { chat: 'p1', review: null, extraction: null, decision: null } }), [profile()])
    expect(rows[0]!.serves).toEqual(['review', 'extraction'])
    expect(rows[1]!.serves).toEqual(['chat'])
  })

  it('sends a route at a disabled or deleted profile back to the default, as the resolver does', () => {
    const routing = { chat: 'p1', review: 'gone', extraction: null, decision: null }
    const rows = buildProviderRows(settings({ routing }), [profile({ enabled: false })])
    expect(rows[0]!.serves).toEqual(['chat', 'review', 'extraction'])
    expect(rows[1]!.serves).toEqual([])
  })

  it('never falls a decision back to the default', () => {
    const routing = { chat: null, review: null, extraction: null, decision: 'p1' }
    expect(buildProviderRows(settings({ routing }), [profile()])[1]!.serves).toEqual(['decision'])
    const off = settings({ routing, decision: { available: false } } as never)
    expect(buildProviderRows(off, [profile()])[1]!.serves).toEqual([])
    expect(buildProviderRows(settings(), [])[0]!.serves).not.toContain('decision')
  })

  it('claims no work for a default of none', () => {
    const [row] = buildProviderRows(settings({ provider: 'none', hasApiKey: false, model: '' }), [])
    expect(row).toMatchObject({ enabled: false, serves: [], host: null, key: { source: 'missing' } })
  })

  it('says where a key comes from', () => {
    const stored = settings({ sources: { ...env, apiKey: 'db' }, apiKeyHint: '…1234' } as never)
    expect(buildProviderRows(stored, [])[0]!.key).toEqual({ source: 'stored', hint: '…1234' })
    expect(buildProviderRows(settings(), [])[0]!.key).toEqual({ source: 'environment' })
    expect(buildProviderRows(settings(), [profile()])[1]!.key).toEqual({ source: 'default' })
  })

  it('prices a row by the usage rule: list, override, or nothing', () => {
    const rows = buildProviderRows(settings(), [
      profile(),
      profile({ id: 'p2', pricePromptPerMTok: 1, priceCompletionPerMTok: 2 }),
      profile({ id: 'p3', pricePromptPerMTok: 1 }),
    ])
    expect(rows[0]!.price).toEqual({ prompt: 0.27, completion: 1.1, custom: false })
    expect(rows[1]!.price).toBeNull()
    expect(rows[2]!.price).toEqual({ prompt: 1, completion: 2, custom: true })
    expect(rows[3]!.price).toBeNull()
  })

  it('keeps a stale error off a profile that is not failing', () => {
    const rows = buildProviderRows(settings(), [profile(), profile({ id: 'p2', status: 'error', lastError: 'boom' })])
    expect(rows[1]!.error).toBeNull()
    expect(rows[2]!.error).toBe('boom')
  })

  it('stops calling the default environment-only once a price is set', () => {
    expect(buildProviderRows(settings({ pricePromptPerMTok: 1 }), [])[0]!.fromEnvironment).toBe(false)
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
