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
  it('uses the list for a known model', () => {
    expect(effectiveModelPrice('deepseek-chat', null, null)).toEqual({ prompt: 0.27, completion: 1.1, custom: false });
  });

  it('falls back side by side, and says a configured price decided', () => {
    expect(effectiveModelPrice('deepseek-chat', 1, null)).toEqual({ prompt: 1, completion: 1.1, custom: true });
  });

  it('has no price for an unlisted model missing a side', () => {
    expect(effectiveModelPrice('gpt-6-luna', null, null)).toBeNull();
    expect(effectiveModelPrice('gpt-6-luna', 1, null)).toBeNull();
    expect(effectiveModelPrice('gpt-6-luna', 1, 2)).toEqual({ prompt: 1, completion: 2, custom: true });
  });

  it('treats an explicit 0 as a price: a self-hosted model is free, not unknown', () => {
    expect(effectiveModelPrice('llama', 0, 0)).toEqual({ prompt: 0, completion: 0, custom: true });
  });
});

describe('estimateCostMicros', () => {
  const estimate = AiConfigService.prototype.estimateCostMicros;
  const config = (over: Partial<ResolvedAiConfig>) =>
    ({ model: 'deepseek-chat', pricePromptPerMTok: null, priceCompletionPerMTok: null, ...over }) as ResolvedAiConfig;

  it('prices tokens by that rule', () => {
    expect(estimate(config({}), 1_000_000, 1_000_000)).toBe(1_370_000);
    expect(estimate(config({ model: 'gpt-6-luna' }), 1_000_000, 0)).toBeNull();
    expect(estimate(config({ model: 'llama', pricePromptPerMTok: 0, priceCompletionPerMTok: 0 }), 1_000, 1_000)).toBe(0);
  });
});

describe('AiSettingsService.test', () => {
  function service() {
    const off = { enabled: false };
    const aiConfig = { resolve: vi.fn().mockResolvedValue(off), resolveFor: vi.fn().mockResolvedValue(off) };
    return { aiConfig, settings: new AiSettingsService({} as never, aiConfig as never, {} as never, {} as never, {} as never, {} as never) };
  }

  it('tests the default config itself when asked, not the route', async () => {
    const { aiConfig, settings } = service();
    await settings.test('ws', 'user', undefined, true);
    expect(aiConfig.resolve).toHaveBeenCalledWith('ws');
    expect(aiConfig.resolveFor).not.toHaveBeenCalled();
  });

  it('tests a named profile, and otherwise whatever chat is routed at', async () => {
    const { aiConfig, settings } = service();
    await settings.test('ws', 'user', 'p1');
    expect(aiConfig.resolveFor).toHaveBeenLastCalledWith('ws', 'chat', 'p1');
    await settings.test('ws', 'user');
    expect(aiConfig.resolveFor).toHaveBeenLastCalledWith('ws', 'chat', undefined);
    expect(aiConfig.resolve).not.toHaveBeenCalled();
  });
});
