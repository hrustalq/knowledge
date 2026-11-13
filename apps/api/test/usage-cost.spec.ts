import { describe, expect, it, vi } from 'vitest';
import { AgentRouterService } from '../src/agents/agent-router.service.js';
import { AiConfigService, type ResolvedAiConfig } from '../src/ai/ai-config.service.js';
import { AiUsageService, type AiUsageTokens } from '../src/ai/ai-usage.service.js';
import { fromUsage } from '../src/assistant/assistant.client.js';
import { MemosProcessor } from '../src/memos/memos.processor.js';
import { AUTHOR_ID_STUB } from '../src/activity/actor.js';

/**
 * What a call costs, and in what (#793). The usage blocks here are the shapes
 * gen-api and DeepSeek really return; gen-api's were recorded on the issue.
 */

vi.mock('../src/memos/audio.js', () => ({
  probeSeconds: vi.fn(async () => 2.39),
  detectPauses: vi.fn(async () => []),
  pauseCuts: vi.fn(() => []),
  fixedCuts: vi.fn(() => []),
  splitAudio: vi.fn(async () => [{ path: '/tmp/chunk.mp3', offset: 0, duration: 2.39 }]),
}));

const GEN_API_USAGE = {
  completion_tokens: 3,
  prompt_tokens: 9,
  total_tokens: 12,
  prompt_tokens_details: { cached_tokens: 0 },
  cost: 0.0105,
  cached_tokens: 0,
};

const config = (over: Partial<ResolvedAiConfig> = {}) =>
  ({
    workspaceId: 'ws',
    provider: 'openai-compatible',
    model: 'gpt-4.1',
    providerId: null,
    pricePromptPerMTok: null,
    priceCompletionPerMTok: null,
    priceCachedPerMTok: null,
    priceCurrency: null,
    ...over,
  }) as ResolvedAiConfig;

function service() {
  const create = vi.fn(async (_: { data: Record<string, unknown> }) => ({}));
  const aiConfig = { estimateCost: AiConfigService.prototype.estimateCost };
  return { create, usage: new AiUsageService({ aiUsage: { create } } as never, aiConfig as never, { get: () => 'none' } as never) };
}

async function stored(cfg: ResolvedAiConfig, tokens: AiUsageTokens) {
  const { create, usage } = service();
  await usage.record({ config: cfg, userId: 'u', operation: 'ask', tokens, durationMs: 1, ok: true });
  return create.mock.calls[0]![0].data;
}

describe('cached prompt tokens', () => {
  const deepseek = (hit: number) => ({
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    total_tokens: 1_000_000,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: 1_000_000 - hit,
  });

  it('reads DeepSeek hits and OpenAI details, and keeps them inside the prompt count', () => {
    expect(fromUsage(deepseek(250_000) as never)).toMatchObject({ promptTokens: 1_000_000, cachedPromptTokens: 250_000 });
    expect(fromUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 4 } })).toMatchObject({
      promptTokens: 10,
      cachedPromptTokens: 4,
    });
  });

  it('prices a hit at the cached rate, and stores the same token counts as before', async () => {
    const miss = await stored(config(), fromUsage(deepseek(0) as never));
    const hit = await stored(config(), fromUsage(deepseek(1_000_000) as never));
    expect(miss).toMatchObject({ costMicros: 2_000_000, costCurrency: 'USD' });
    expect(hit).toMatchObject({ costMicros: 500_000, costCurrency: 'USD' });
    // Budgets sum total_tokens, so a cache hit must not change any count.
    for (const row of [miss, hit]) expect(row).toMatchObject({ promptTokens: 1_000_000, totalTokens: 1_000_000 });
  });

  it('uses a provider-configured cached rate, and charges full price with none', async () => {
    const priced = { pricePromptPerMTok: 1, priceCompletionPerMTok: 2 };
    const tokens = fromUsage(deepseek(1_000_000) as never);
    expect(await stored(config({ model: 'deepseek-flash', ...priced, priceCachedPerMTok: 0.01 }), tokens)).toMatchObject({ costMicros: 10_000 });
    expect(await stored(config({ model: 'deepseek-flash', ...priced }), tokens)).toMatchObject({ costMicros: 1_000_000 });
  });

  it('never counts more cached tokens than prompt tokens', () => {
    expect(AiConfigService.prototype.estimateCost(config(), 10, 0, 999)).toEqual({ micros: 5, currency: 'USD' });
  });
});

describe('a cost states its currency', () => {
  it("stores what gen-api says it charged, in rubles, over any estimate", async () => {
    const row = await stored(config({ provider: 'gen-api', model: 'gpt-4-1' }), fromUsage(GEN_API_USAGE as never));
    expect(row).toMatchObject({ costMicros: 10_500, costCurrency: 'RUB', promptTokens: 9, completionTokens: 3 });
  });

  it("does not trust `usage.cost` from any other server: its units are unknown", async () => {
    const row = await stored(config({ provider: 'openai-compatible', model: 'gpt-4.1' }), fromUsage(GEN_API_USAGE as never));
    expect(row).toMatchObject({ costCurrency: 'USD', costMicros: 42 });
  });

  it('estimates a GenAPI call that reports nothing in its list currency', async () => {
    const row = await stored(config({ provider: 'gen-api', model: 'gpt-4-1' }), {
      promptTokens: 1_000,
      completionTokens: 0,
      totalTokens: 1_000,
      estimated: true,
    });
    expect(row).toMatchObject({ costMicros: 400_000, costCurrency: 'RUB' });
  });

  it('prices a ruble provider in rubles, and a model with no price stays unpriced', async () => {
    const tokens = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, estimated: false };
    const rubles = config({ model: 'other', pricePromptPerMTok: 300, priceCompletionPerMTok: 900, priceCurrency: 'RUB' });
    expect(await stored(rubles, tokens)).toMatchObject({ costMicros: 300_000_000, costCurrency: 'RUB' });
    const row = await stored(config({ model: 'other' }), tokens);
    expect(row.costMicros).toBeNull();
    expect(row).not.toHaveProperty('costCurrency');
  });

  it('a memo records what gen-stt reported, in rubles', async () => {
    const recordTranscription = vi.fn(async () => undefined);
    const prisma = {
      memo: {
        findUnique: vi.fn(async () => ({ id: 'm', workspaceId: 'ws', createdBy: 'u', audioKey: 'k', transcript: null, locale: 'en' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
    };
    const stt = {
      provider: 'gen-api',
      model: 'gen-stt',
      transcribe: vi.fn(async () => ({ offset: 0, duration: 2.39, language: null, text: 'hello', segments: [], cost: 0.0179 })),
    };
    const processor = new MemosProcessor(
      prisma as never,
      { downloadToFile: vi.fn(async () => undefined) } as never,
      stt as never,
      { recordTranscription } as never,
      { enqueue: vi.fn(async () => undefined) } as never,
      { get: () => 120 } as never,
    );
    await processor.process({ data: { memoId: 'm' } } as never);
    expect(recordTranscription).toHaveBeenCalledWith(
      expect.objectContaining({ cost: { micros: 17_900, currency: 'RUB' }, audioSeconds: 2 }),
    );
  });
});

describe('usage totals', () => {
  it('keeps one total per currency, and still counts the calls it could not price', async () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const row = (over: object) => ({
      userId: 'u',
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      costMicros: null,
      costCurrency: 'USD',
      ok: true,
      createdAt: at,
      ...over,
    });
    const findMany = vi.fn(async () => [
      row({ costMicros: 1_000_000, costCurrency: 'USD' }),
      row({ costMicros: 500_000, costCurrency: 'RUB' }),
      row({ costMicros: 2_000_000, costCurrency: 'USD' }),
      row({}),
    ]);
    const prisma = { aiUsage: { findMany }, user: { findMany: vi.fn(async () => []) }, publishedSite: { findMany: vi.fn(async () => []) } };
    const res = await new AiUsageService(prisma as never, {} as never, { get: () => 'none' } as never).summarize('ws', { groupBy: 'model' });
    const expected = [
      { micros: 500_000, currency: 'RUB' },
      { micros: 3_000_000, currency: 'USD' },
    ];
    expect(res.totals.costs).toEqual(expected);
    expect(res.totals.unpricedCalls).toBe(1);
    expect(res.buckets[0]!.costs).toEqual(expected);
    expect(res.series[0]!.costs).toEqual(expected);
  });
});

describe('usage labels for the all-zeros id (#1023)', () => {
  const summarize = (authMode: string) => {
    const findMany = vi.fn(async () => [
      { userId: AUTHOR_ID_STUB, model: 'm', promptTokens: 1, completionTokens: 1, totalTokens: 2, costMicros: null, costCurrency: 'USD', ok: true, createdAt: new Date('2026-11-01T00:00:00Z') },
    ]);
    const prisma = { aiUsage: { findMany }, user: { findMany: vi.fn(async () => []) }, publishedSite: { findMany: vi.fn(async () => []) } };
    return new AiUsageService(prisma as never, {} as never, { get: () => authMode } as never).summarize('ws', { groupBy: 'user' });
  };

  it('is the system actor when people sign in with keys: only system work bills it there', async () => {
    expect((await summarize('api-key')).buckets[0]!.label).toBe('role.system');
  });

  it('is still the dev principal under AUTH_MODE=none', async () => {
    expect((await summarize('none')).buckets[0]!.label).toBe('dev (AUTH_MODE=none)');
  });
});

describe('cheapestCapable', () => {
  const pick = (profiles: object[]) =>
    AgentRouterService.prototype.cheapestCapable.call(
      { aiConfig: { availableModels: async () => profiles } } as never,
      'ws',
      [],
    );
  const profile = (id: string, price: number | null, priceCurrency: string | null = null) => ({
    id,
    code: 'm',
    capabilities: null,
    pricePromptPerMTok: price,
    priceCurrency,
  });

  it('never compares a ruble figure with a dollar one', async () => {
    expect(await pick([profile('rub', 1, 'RUB'), profile('usd', 2, 'USD')])).toBe('usd');
    expect(await pick([profile('rub', 1, 'RUB'), profile('none', null)])).toBe('rub');
    expect(await pick([profile('dear', 900, 'RUB'), profile('cheap', 300, 'RUB')])).toBe('cheap');
    expect(await pick([profile('dear', 5), profile('cheap', 1)])).toBe('cheap');
  });
});
