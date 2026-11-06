import { describe, expect, it, vi } from 'vitest';
import { AiConfigService } from '../src/ai/ai-config.service.js';
import { AiModelsService, toModelSummary } from '../src/ai/ai-models.service.js';
import { AssistantThreadsService } from '../src/assistant/assistant-threads.service.js';

/**
 * A provider is a connection; a model is something it serves (#798).
 *
 * 1. **An empty table is the old behaviour.** No model, no pin: the inline config.
 * 2. **A pin that cannot run is looked past, never fatal.** A removed model, another
 *    workspace's, one whose provider is off: the next pin, then the route, then the
 *    inline config. Off keeps the pin, so turning the provider on restores it.
 * 3. **"In chat" is members' only.** It stops a thread's pin, not an agent's.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const base = {
  workspaceId: WS,
  enabled: true,
  provider: 'deepseek',
  baseUrl: 'https://default',
  model: 'implicit',
  apiKey: 'default-key',
  temperature: 0.2,
  maxToolCalls: 8,
  timeoutMs: 1000,
  pricePromptPerMTok: 9,
  priceCompletionPerMTok: 9,
  priceCachedPerMTok: null,
  priceCurrency: null,
  providerId: null,
  providerName: null,
  modelId: null,
  capabilities: null,
};

const provider = (over = {}) => ({
  id: 'p1',
  workspaceId: WS,
  name: 'Luna',
  provider: 'gen-api',
  baseUrl: 'https://luna/v1/',
  temperature: null,
  maxToolCalls: null,
  timeoutMs: null,
  enabled: true,
  ...over,
});

const model = (over = {}) => ({
  id: 'm1',
  workspaceId: WS,
  providerId: 'p1',
  code: 'gpt-6-luna',
  source: 'manual',
  inChat: true,
  pricePromptPerMTok: null,
  priceCompletionPerMTok: null,
  priceCachedPerMTok: null,
  priceCurrency: null,
  capabilities: null,
  provider: { name: 'Luna', provider: 'gen-api', enabled: true },
  ...over,
});

/** The real resolver over a fake store: `rows` are ai_models, `route` the chat route. */
function config(opts: { rows?: ReturnType<typeof model>[]; providers?: ReturnType<typeof provider>[]; route?: string; base?: object } = {}) {
  const rows = opts.rows ?? [];
  const providers = opts.providers ?? [provider()];
  const svc = Object.create(AiConfigService.prototype) as AiConfigService;
  Object.assign(svc, {
    resolve: async () => ({ ...base, ...opts.base }),
    prisma: { aiSettings: { findUnique: async () => (opts.route ? { chatModelId: opts.route } : null) } },
    models: {
      find: async (workspaceId: string, id: string) => rows.find((m) => m.id === id && m.workspaceId === workspaceId) ?? null,
      roster: async (workspaceId: string) => rows.filter((m) => m.workspaceId === workspaceId),
    },
    providers: {
      resolveRow: async (id: string) => {
        const row = providers.find((p) => p.id === id);
        return row?.enabled ? { row, apiKey: 'luna-key' } : null;
      },
    },
  });
  return svc;
}

describe('AiConfigService.resolveFor', () => {
  it('is the inline config when nothing is pinned or routed', async () => {
    expect(await config().resolveFor(WS, 'chat')).toMatchObject({ model: 'implicit', baseUrl: 'https://default', modelId: null });
  });

  it('dials the model\'s provider, on the model\'s code and prices', async () => {
    const rows = [model({ pricePromptPerMTok: 3, priceCompletionPerMTok: 4, priceCurrency: 'RUB', capabilities: ['vision'] })];
    expect(await config({ rows }).resolveFor(WS, 'chat', 'm1')).toMatchObject({
      model: 'gpt-6-luna',
      modelId: 'm1',
      provider: 'gen-api',
      providerId: 'p1',
      providerName: 'Luna',
      baseUrl: 'https://luna/v1',
      apiKey: 'luna-key',
      pricePromptPerMTok: 3,
      priceCompletionPerMTok: 4,
      priceCurrency: 'RUB',
      capabilities: ['vision'],
    });
  });

  it('never carries the inline config\'s price onto a provider\'s model', async () => {
    expect(await config({ rows: [model()] }).resolveFor(WS, 'chat', 'm1')).toMatchObject({ pricePromptPerMTok: null, priceCurrency: null });
  });

  it('keeps the default connection for a model of the default config', async () => {
    const rows = [model({ id: 'm2', providerId: null, provider: null, code: 'other' })];
    expect(await config({ rows }).resolveFor(WS, 'chat', 'm2')).toMatchObject({
      model: 'other',
      modelId: 'm2',
      provider: 'deepseek',
      baseUrl: 'https://default',
      apiKey: 'default-key',
      providerId: null,
    });
  });

  it('prefers the first pin that can run: thread, then agent, then route', async () => {
    const rows = [model(), model({ id: 'm2', code: 'two' }), model({ id: 'm3', code: 'three' })];
    const svc = config({ rows, route: 'm3' });
    expect((await svc.resolveFor(WS, 'chat', 'm1', 'm2')).model).toBe('gpt-6-luna');
    expect((await svc.resolveFor(WS, 'chat', null, 'm2')).model).toBe('two');
    expect((await svc.resolveFor(WS, 'chat', 'gone', undefined)).model).toBe('three');
  });

  it('looks past a model of a provider that is off, down to the inline config', async () => {
    const providers = [provider({ enabled: false })];
    const svc = config({ rows: [model()], providers, route: 'm1' });
    expect(await svc.resolveFor(WS, 'chat', 'm1')).toMatchObject({ model: 'implicit', modelId: null });
  });

  it('honours the pin again once the provider is back on', async () => {
    const providers = [provider({ enabled: false })];
    const svc = config({ rows: [model()], providers });
    expect((await svc.resolveFor(WS, 'chat', 'm1')).modelId).toBeNull();
    providers[0]!.enabled = true;
    expect((await svc.resolveFor(WS, 'chat', 'm1')).modelId).toBe('m1');
  });

  it('ignores a model of another workspace', async () => {
    const rows = [model({ workspaceId: OTHER })];
    expect(await config({ rows }).resolveFor(WS, 'chat', 'm1')).toMatchObject({ model: 'implicit', apiKey: 'default-key' });
  });

  it('ignores a provider of another workspace behind a model of this one', async () => {
    const providers = [provider({ workspaceId: OTHER })];
    expect(await config({ rows: [model()], providers }).resolveFor(WS, 'chat', 'm1')).toMatchObject({ model: 'implicit' });
  });

  it('will not run a model of the default config while that config is off', async () => {
    const rows = [model({ id: 'm2', providerId: null, provider: null })];
    const svc = config({ rows, base: { enabled: false, provider: 'none' } });
    expect((await svc.resolveFor(WS, 'chat', 'm2')).modelId).toBeNull();
  });
});

describe('what a provider being off hides', () => {
  const rows = [
    model(),
    model({ id: 'm2', providerId: 'p2', provider: { name: 'Off', provider: 'deepseek', enabled: false } }),
    model({ id: 'm3', providerId: null, provider: null }),
  ];

  it('drops an off provider\'s models from what can be called, and the sum', async () => {
    const available = await config({ rows }).availableModels(WS);
    expect(available.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('drops the default config\'s models while it is provider none', async () => {
    const available = await config({ rows, base: { provider: 'none' } }).availableModels(WS);
    expect(available.map((m) => m.id)).toEqual(['m1']);
  });

  it('reports it on the summary, and never an endpoint or credential', () => {
    const summary = toModelSummary(rows[1] as never, 'deepseek');
    expect(summary).toMatchObject({ available: false, kind: 'deepseek', providerName: 'Off' });
    expect(Object.keys(summary)).not.toEqual(expect.arrayContaining(['baseUrl']));
    expect(Object.keys(summary)).not.toEqual(expect.arrayContaining(['apiKey']));
  });
});

describe('"In chat"', () => {
  const rows = [model(), model({ id: 'm2', inChat: false })];

  it('stops a thread\'s pin on execution', async () => {
    const svc = config({ rows });
    expect(await svc.chatPin(WS, 'm1')).toBe('m1');
    expect(await svc.chatPin(WS, 'm2')).toBeNull();
    expect(await svc.chatPin(WS, null)).toBeNull();
  });

  it('leaves an agent\'s pin alone', async () => {
    expect((await config({ rows }).resolveFor(WS, 'chat', null, 'm2')).modelId).toBe('m2');
  });
});

describe('AiConfigService.connection', () => {
  it('tests on a model members can use, then any, then the kind\'s default', async () => {
    const first = model({ id: 'a', code: 'off-chat', inChat: false });
    const second = model({ id: 'b', code: 'on-chat' });
    expect((await config({ rows: [first, second] }).connection(WS, 'p1'))?.model).toBe('on-chat');
    expect((await config({ rows: [first] }).connection(WS, 'p1'))?.model).toBe('off-chat');
    expect((await config({ rows: [] }).connection(WS, 'p1'))?.model).toBe('gpt-4-1');
  });

  it('has nothing to dial for a provider that is off', async () => {
    expect(await config({ providers: [provider({ enabled: false })] }).connection(WS, 'p1')).toBeNull();
  });
});

describe('AiModelsService', () => {
  function service() {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const updateMany = vi.fn().mockImplementation((args) => args);
    const prisma = {
      aiProvider: { findFirst: vi.fn(async ({ where }) => (where.workspaceId === WS && where.id === 'p1' ? { id: 'p1' } : null)) },
      aiModel: { createMany, count: vi.fn(async ({ where }) => where.id.in.filter((id: string) => id === 'mine').length) },
      aiSettings: { updateMany },
      aiAgent: { updateMany },
      assistantThread: { updateMany },
    };
    return { svc: new AiModelsService(prisma as never), createMany, updateMany };
  }

  it('adds trimmed, unique codes, and lets the index skip one the provider already has', async () => {
    const { svc, createMany } = service();
    await svc.add(WS, 'p1', [' a ', 'a', 'b', ''], 'fetched', 'u1');
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: WS, providerId: 'p1', code: 'a', source: 'fetched', createdBy: 'u1' },
        { workspaceId: WS, providerId: 'p1', code: 'b', source: 'fetched', createdBy: 'u1' },
      ],
      skipDuplicates: true,
    });
  });

  it('adds to the default config with no provider row, and refuses another workspace\'s provider', async () => {
    const { svc, createMany } = service();
    await svc.add(WS, null, ['a'], 'manual');
    expect(createMany.mock.calls[0]![0].data[0]).toMatchObject({ providerId: null, createdBy: null });
    await expect(svc.add(OTHER, 'p1', ['a'], 'manual')).rejects.toThrow();
  });

  it('refuses a write naming a model of another workspace', async () => {
    const { svc } = service();
    await expect(svc.assertInWorkspace(WS, ['mine', 'mine'])).resolves.toBeUndefined();
    await expect(svc.assertInWorkspace(WS, ['mine', 'theirs'])).rejects.toThrow();
    await expect(svc.assertInWorkspace(WS, [])).resolves.toBeUndefined();
  });

  it('clears every pin: four routes, agents and threads, in this workspace only', () => {
    const { svc, updateMany } = service();
    svc.clearPins(WS, ['m1']);
    expect(updateMany).toHaveBeenCalledTimes(6);
    const columns = updateMany.mock.calls.map(([args]) => Object.keys(args.data)[0]);
    expect(columns).toEqual(['chatModelId', 'reviewModelId', 'extractionModelId', 'decisionModelId', 'modelId', 'modelId']);
    for (const [args] of updateMany.mock.calls) expect(args.where.workspaceId).toBe(WS);
  });
});

describe('pinning a thread', () => {
  function threads(found: unknown) {
    const update = vi.fn(async () => ({ id: 't1', modelId: 'm1', workspaceId: WS }));
    const findFirst = vi.fn(async () => found);
    const svc = Object.create(AssistantThreadsService.prototype) as AssistantThreadsService;
    Object.assign(svc, {
      getThreadOrThrow: async () => ({ id: 't1', workspaceId: WS }),
      toSummary: (row: unknown) => row,
      prisma: { aiModel: { findFirst }, assistantThread: { update } },
    });
    return { svc, findFirst, update };
  }

  it('asks only for an "In chat" model of the thread\'s own workspace', async () => {
    const { svc, findFirst } = threads({ provider: { enabled: true } });
    await svc.updateThread('t1', { modelId: 'm1' });
    expect(findFirst.mock.calls[0]).toMatchObject([{ where: { id: 'm1', workspaceId: WS, inChat: true } }]);
  });

  it('refuses one it cannot find, or whose provider is off', async () => {
    for (const found of [null, { provider: { enabled: false } }]) {
      const { svc, update } = threads(found);
      await expect(svc.updateThread('t1', { modelId: 'm1' })).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('accepts a model of the default config, and clearing the pin', async () => {
    const { svc, findFirst, update } = threads({ provider: null });
    await svc.updateThread('t1', { modelId: 'm1' });
    await svc.updateThread('t1', { modelId: null });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
