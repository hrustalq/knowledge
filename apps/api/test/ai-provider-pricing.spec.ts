import { describe, expect, it, vi } from 'vitest';
import { effectiveModelPrice } from '@knowledge/contracts';
import { AiConfigService, type ResolvedAiConfig } from '../src/ai/ai-config.service.js';
import { AiSettingsService } from '../src/ai/ai-settings.service.js';

/**
 * Provider pricing and the provider list's Test button.
 *
 * 1. **One price rule.** Each side falls back to the list on its own; a model
 *    missing a side has no price, so the settings row and the usage row agree.
 * 2. **Each row tests itself.** The default row tests the default config even
 *    while chat is routed at a profile; with no target it is still chat's route.
 */

describe('effectiveModelPrice', () => {
  const custom = (prompt: number | null, completion: number | null) => ({ pricePromptPerMTok: prompt, priceCompletionPerMTok: completion });

  it('uses the list for a known model, with its cached rate and currency', () => {
    expect(effectiveModelPrice('gpt-4o')).toEqual({ prompt: 2.5, cachedPrompt: 1.25, completion: 10, currency: 'USD', custom: false });
    expect(effectiveModelPrice('gpt-4-1')).toEqual({ prompt: 400, cachedPrompt: null, completion: 1600, currency: 'RUB', custom: false });
  });

  it('has dropped the models DeepSeek no longer lists', () => {
    expect(effectiveModelPrice('deepseek-chat')).toBeNull();
    expect(effectiveModelPrice('deepseek-reasoner')).toBeNull();
  });

  it('falls back side by side, and says a configured price decided', () => {
    expect(effectiveModelPrice('gpt-4o', custom(1, null))).toEqual({ prompt: 1, cachedPrompt: null, completion: 10, currency: 'USD', custom: true });
  });

  it('has no price for an unlisted model missing a side', () => {
    expect(effectiveModelPrice('gpt-6-luna')).toBeNull();
    expect(effectiveModelPrice('gpt-6-luna', custom(1, null))).toBeNull();
    expect(effectiveModelPrice('gpt-6-luna', custom(1, 2))).toEqual({ prompt: 1, cachedPrompt: null, completion: 2, currency: 'USD', custom: true });
  });

  it('treats an explicit 0 as a price: a self-hosted model is free, not unknown', () => {
    expect(effectiveModelPrice('llama', custom(0, 0))).toEqual({ prompt: 0, cachedPrompt: null, completion: 0, currency: 'USD', custom: true });
  });

  it('reads a price stored before currencies as USD, even on a model the list prices in rubles', () => {
    expect(effectiveModelPrice('gpt-4-1', custom(2, 8))).toMatchObject({ prompt: 2, completion: 8, currency: 'USD' });
  });

  it('fills a side from the list only in its own currency: no rate is kept to convert it', () => {
    expect(effectiveModelPrice('gpt-4o', { pricePromptPerMTok: 200, priceCurrency: 'RUB' })).toBeNull();
    expect(effectiveModelPrice('gpt-4o', { priceCurrency: 'RUB' })).toBeNull();
    expect(effectiveModelPrice('gpt-4o', { ...custom(200, 800), priceCurrency: 'RUB' })).toMatchObject({ prompt: 200, currency: 'RUB' });
  });

  it('keeps a list cached rate off a configured prompt rate, unless one is configured too', () => {
    expect(effectiveModelPrice('gpt-4o', custom(1, 2))?.cachedPrompt).toBeNull();
    expect(effectiveModelPrice('gpt-4o', { ...custom(1, 2), priceCachedPerMTok: 0.1 })?.cachedPrompt).toBe(0.1);
    expect(effectiveModelPrice('gpt-4o', custom(null, 2))?.cachedPrompt).toBe(1.25);
  });
});

describe('estimateCost', () => {
  const estimate = AiConfigService.prototype.estimateCost;
  const config = (over: Partial<ResolvedAiConfig>) =>
    ({ model: 'gpt-4o', pricePromptPerMTok: null, priceCompletionPerMTok: null, ...over }) as ResolvedAiConfig;

  it('prices tokens by that rule', () => {
    expect(estimate(config({}), 1_000_000, 1_000_000)).toEqual({ micros: 12_500_000, currency: 'USD' });
    expect(estimate(config({ model: 'gpt-6-luna' }), 1_000_000, 0)).toBeNull();
    expect(estimate(config({ model: 'llama', pricePromptPerMTok: 0, priceCompletionPerMTok: 0 }), 1_000, 1_000)).toEqual({ micros: 0, currency: 'USD' });
  });
});

describe('AiSettingsService.test', () => {
  function service() {
    const off = { enabled: false };
    const aiConfig = {
      resolve: vi.fn().mockResolvedValue(off),
      resolveFor: vi.fn().mockResolvedValue(off),
      connection: vi.fn().mockResolvedValue(off),
    };
    return { aiConfig, settings: new AiSettingsService({} as never, aiConfig as never, {} as never, {} as never, {} as never, {} as never, {} as never) };
  }

  it('tests the default config itself when asked, not the route', async () => {
    const { aiConfig, settings } = service();
    await settings.test('ws', 'user', undefined, true);
    expect(aiConfig.resolve).toHaveBeenCalledWith('ws');
    expect(aiConfig.resolveFor).not.toHaveBeenCalled();
  });

  it('tests a named provider, and otherwise whatever chat is routed at', async () => {
    const { aiConfig, settings } = service();
    await settings.test('ws', 'user', 'p1');
    expect(aiConfig.connection).toHaveBeenLastCalledWith('ws', 'p1');
    expect(aiConfig.resolveFor).not.toHaveBeenCalled();
    await settings.test('ws', 'user');
    expect(aiConfig.resolveFor).toHaveBeenLastCalledWith('ws', 'chat');
    expect(aiConfig.resolve).not.toHaveBeenCalled();
  });

  it('asks for a model before dialling a provider that has none', async () => {
    const { aiConfig, settings } = service();
    aiConfig.connection.mockResolvedValue({ enabled: true, model: '' });
    expect(await settings.test('ws', 'user', 'p1')).toMatchObject({ ok: false, error: 'error.ai.providerNoModels' });
  });
});
