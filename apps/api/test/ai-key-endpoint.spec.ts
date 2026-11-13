import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/ai/secret-box.js';
import { AiConfigService } from '../src/ai/ai-config.service.js';
import { AiProvidersService } from '../src/ai/ai-providers.service.js';

/**
 * GHSA-7hf4-5chc-29gr: a key goes only to the endpoint it was given for. The
 * env `ASSISTANT_API_KEY` dials only the env endpoint, a workspace row that
 * points somewhere else must carry its own key, and moving a row's endpoint
 * drops the key stored for the old one.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const key = randomBytes(32);
const ENV: Record<string, unknown> = {
  ASSISTANT_PROVIDER: 'deepseek',
  ASSISTANT_BASE_URL: '',
  ASSISTANT_MODEL: 'deepseek-chat',
  ASSISTANT_API_KEY: 'sk-operator',
  SETTINGS_ENCRYPTION_KEY: key.toString('base64'),
  ASSISTANT_MAX_TOOL_CALLS: 6,
  ASSISTANT_TIMEOUT_MS: 1000,
  AI_PROVIDERS_ALLOW_PRIVATE_URLS: false,
};
const config = (over: Record<string, unknown> = {}) => ({ get: (name: string) => ({ ...ENV, ...over })[name] });

function configService(opts: { settings?: Record<string, unknown> | null; provider?: Record<string, unknown> | null; providerKey?: string | null }) {
  const prisma = { aiSettings: { findUnique: vi.fn(async () => opts.settings ?? null) } };
  const providers = {
    resolveRow: vi.fn(async () =>
      opts.provider ? { row: { id: 'p1', name: 'P', workspaceId: WS, enabled: true, ...opts.provider }, apiKey: opts.providerKey ?? null } : null,
    ),
  };
  const models = { find: vi.fn(async () => ({ id: 'm1', code: 'some-model', providerId: 'p1', capabilities: null })) };
  const sourcePolicies = { webAccess: () => ({ effective: 'off', source: 'env' }) };
  return new AiConfigService(config() as never, prisma as never, providers as never, models as never, sourcePolicies as never);
}

describe('which key an endpoint gets', () => {
  it('keeps the env key on the env endpoint', async () => {
    const resolved = await configService({}).resolve(WS);
    expect(resolved.baseUrl).toBe('https://api.deepseek.com');
    expect(resolved.apiKey).toBe('sk-operator');
  });

  it('never sends the env key to a base URL the workspace set', async () => {
    const resolved = await configService({ settings: { baseUrl: 'https://collector.example.test/v1' } }).resolve(WS);
    expect(resolved.apiKey).toBe('');
  });

  it('never sends the env key to a named provider pointed elsewhere without its own key', async () => {
    const resolved = await configService({ provider: { provider: 'openai-compatible', baseUrl: 'https://collector.example.test/v1' } }).resolveFor(WS, 'chat', 'm1');
    expect(resolved.providerId).toBe('p1');
    expect(resolved.apiKey).toBe('');
  });

  it('lets a provider on the same endpoint share the key, and a provider with its own key use it', async () => {
    const same = await configService({ provider: { provider: 'deepseek', baseUrl: null } }).resolveFor(WS, 'chat', 'm1');
    expect(same.apiKey).toBe('sk-operator');
    const own = await configService({ provider: { provider: 'openai-compatible', baseUrl: 'https://llm.example.test/v1' }, providerKey: 'sk-theirs' }).resolveFor(WS, 'chat', 'm1');
    expect(own.apiKey).toBe('sk-theirs');
  });

  it('may dial a private address only on the operator endpoint, unless the flag allows it', async () => {
    expect((await configService({}).resolve(WS)).privateOk).toBe(true);
    expect((await configService({ settings: { baseUrl: 'https://collector.example.test/v1' } }).resolve(WS)).privateOk).toBe(false);
  });
});

describe('saving a provider', () => {
  function providers(current: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data, createdAt: new Date(), updatedAt: new Date() }));
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p2', ...data, createdAt: new Date(), updatedAt: new Date() }));
    const prisma = { aiProvider: { findUnique: vi.fn(async (q: { where: { id?: string } }) => (q.where.id ? current : null)), update, create } };
    const service = new AiProvidersService(prisma as never, { invalidate: vi.fn() } as never, config(over) as never);
    return { service, update, create };
  }
  const stored = { id: 'p1', workspaceId: WS, name: 'P', provider: 'openai-compatible', baseUrl: 'https://203.0.113.10/v1', apiKeyCipher: encryptSecret('sk-theirs', key) };

  it('drops the stored key when the base URL moves and no key comes with it', async () => {
    const { service, update } = providers(stored);
    await service.update('p1', { baseUrl: 'https://203.0.113.66/v1' });
    expect(update.mock.calls[0]![0].data.apiKeyCipher).toBeNull();
  });

  it('keeps the key when the base URL is unchanged, and takes a new one sent with a move', async () => {
    const { service, update } = providers(stored);
    await service.update('p1', { baseUrl: 'https://203.0.113.10/v1', temperature: 0.5 });
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('apiKeyCipher');
    await service.update('p1', { baseUrl: 'https://203.0.113.20/v1', apiKey: 'sk-new' });
    expect(update.mock.calls[1]![0].data.apiKeyCipher).toEqual(expect.any(String));
  });

  it('refuses a private-address base URL unless the deployment allows it', async () => {
    const { service } = providers(stored);
    await expect(service.create(WS, { name: 'X', provider: 'openai-compatible', baseUrl: 'https://169.254.169.254/v1' })).rejects.toThrow();
    await expect(service.update('p1', { baseUrl: 'http://127.0.0.1:11434/v1' })).rejects.toThrow();
    const local = providers(stored, { AI_PROVIDERS_ALLOW_PRIVATE_URLS: true });
    await expect(local.service.update('p1', { baseUrl: 'http://127.0.0.1:11434/v1' })).resolves.toBeDefined();
  });
});
