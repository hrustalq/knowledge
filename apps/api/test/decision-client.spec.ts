import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECISION_DEFAULT_MODEL, DECISION_THRESHOLDS } from '@knowledge/contracts';
import { DecisionClient, JEV_URL, type DecisionRoute } from '../src/assistant/decision.client.js';
import { resolveDecisionSettings } from '../src/ai/decision-settings.js';
import { ProviderAccountError } from '../src/assistant/assistant.client.js';

/**
 * The decision client (#530, phase 1).
 *
 * 1. **A route is something an admin turns on.** Off for the deployment, no
 *    profile routed, or a profile that is not gen-api → null, so every call
 *    site does what it did before #530. Never the inline chat config.
 * 2. **A non-Jev model asks the pinned default**, without the profile's prices.
 * 3. **One noul, one usage row**, under the caller's operation, with the model
 *    the response names and gen-api's own cost; 429 is retried, 402 stops.
 * 4. **Thresholds are sparse** over DECISION_THRESHOLDS.
 */

const base = {
  workspaceId: 'ws',
  provider: 'gen-api',
  model: 'jev-1-13',
  apiKey: 'k',
  timeoutMs: 5_000,
  providerId: 'p1',
  pricePromptPerMTok: null,
  priceCompletionPerMTok: null,
} as unknown as DecisionRoute['config'];

function client(opts: { env?: string; config?: Partial<typeof base> } = {}) {
  const record = vi.fn().mockResolvedValue(undefined);
  const aiConfig = {
    resolveFor: vi.fn().mockResolvedValue({ ...base, ...opts.config }),
    decisionSettings: vi.fn().mockResolvedValue(resolveDecisionSettings(null, true)),
    estimateCostMicros: vi.fn().mockReturnValue(7),
  };
  const config = { get: () => opts.env ?? 'gen-api' };
  return { decision: new DecisionClient(aiConfig as never, { record } as never, config as never), record };
}

const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
const ok = (noul: number) =>
  reply(200, { response: { model: 'jev-1.13-20260917', answers: { answer: { noul } }, usage: { input_tokens: 400, cost: 0.0000168 } } });
const question = { instructions: 'q?', criteria: { true: 'yes', false: 'no' } };

afterEach(() => vi.unstubAllGlobals());

describe('DecisionClient.routeFor', () => {
  it('is null when the deployment is off, nothing is routed, or the profile is not gen-api', async () => {
    expect(await client({ env: 'none' }).decision.routeFor('ws')).toBeNull();
    expect(await client({ config: { providerId: null } }).decision.routeFor('ws')).toBeNull();
    expect(await client({ config: { provider: 'deepseek' } }).decision.routeFor('ws')).toBeNull();
  });

  it('pins the default model, and drops the prices, when the profile names no Jev release', async () => {
    const route = await client({ config: { model: 'gpt-4-1', pricePromptPerMTok: 2 } }).decision.routeFor('ws');
    expect(route?.config.model).toBe(DECISION_DEFAULT_MODEL);
    expect(route?.config.pricePromptPerMTok).toBeNull();
    expect(route?.thresholds).toEqual(DECISION_THRESHOLDS);
    expect((await client({ config: { model: 'jev-latest' } }).decision.routeFor('ws'))?.config.model).toBe('jev-latest');
  });
});

describe('DecisionClient.noul', () => {
  const route: DecisionRoute = { config: base, thresholds: { ...DECISION_THRESHOLDS } };

  it('sends one noul and bills one row with the served model and its cost', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(0.83));
    vi.stubGlobal('fetch', fetch);
    const { decision, record } = client();
    expect(await decision.noul({ route, userId: 'u', operation: 'contradiction' }, { a: 'x' }, question)).toBe(0.83);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(JEV_URL);
    expect(JSON.parse(init.body)).toEqual({
      is_sync: true,
      model: 'jev-1-13',
      state: { a: 'x' },
      questions: { answer: { type: 'noul', ...question } },
    });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      operation: 'contradiction',
      ok: true,
      costUsdMicros: 17,
      config: { model: 'jev-1.13-20260917' },
      tokens: { promptTokens: 400, completionTokens: 0 },
    });
  });

  it('retries a 429, and stops on a 402 as an account error', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(reply(429, {})).mockResolvedValueOnce(ok(0.1));
    vi.stubGlobal('fetch', fetch);
    const pending = client().decision.noul({ route, userId: 'u', operation: 'harvest' }, {}, question);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(0.1);
    vi.useRealTimers();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(402, {})));
    const { decision, record } = client();
    await expect(decision.noul({ route, userId: 'u', operation: 'harvest' }, {}, question)).rejects.toBeInstanceOf(ProviderAccountError);
    expect(record.mock.calls[0]![0]).toMatchObject({ ok: false });
  });

  it('refuses an answer with no probability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { response: { answers: {} } })));
    await expect(client().decision.noul({ route, userId: 'u', operation: 'harvest' }, {}, question)).rejects.toThrow();
  });
});

describe('resolveDecisionSettings', () => {
  it('overrides one site and inherits the rest', () => {
    const s = resolveDecisionSettings(
      { decisionArbiterThreshold: 0.3, decisionCitationThreshold: null, decisionHarvestThreshold: null, decisionTunedModel: 'jev-latest' },
      false,
    );
    expect(s.available).toBe(false);
    expect(s.thresholds.arbiter).toEqual({ requested: 0.3, effective: 0.3 });
    expect(s.thresholds.harvest).toEqual({ requested: null, effective: DECISION_THRESHOLDS.harvest });
    expect(s.tunedOn).toBe('jev-latest');
    expect(resolveDecisionSettings(null, true).tunedOn).toBe(DECISION_DEFAULT_MODEL);
  });
});
