import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { INSTALL_KEY_TTL_MINUTES, KEY_ENV, mcpClients } from '@knowledge/contracts';
import { INSTALL_KEY_OK_META } from '../src/auth/access.decorator.js';
import { ApiKeysService } from '../src/auth/api-keys.service.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { McpController } from '../src/mcp/mcp.controller.js';
import { renderSetupInstaller } from '../src/mcp/setup.js';

/**
 * Browser sign-in in the Connect wizard (#1371, docs/features/33). What is pinned:
 *
 * 1. **A setup key opens the installers and nothing else.** Refused at every
 *    door that does not say `install`, the MCP endpoint included; the six
 *    installer handlers are the only ones that say it.
 * 2. **It lives an hour and drops out of the list after.**
 * 3. **The OAuth rendering carries no credential**, only for clients whose docs
 *    describe MCP OAuth; every other client keeps its key snippet.
 */

const config = { get: (k: string) => ({ AUTH_MODE: 'api-key', MCP_OAUTH_ENABLED: true })[k] } as never;
const user = { id: 'u', email: 'a@example.com', displayName: 'Ada', isAdmin: false, locale: 'en', disabledAt: null, emailVerifiedAt: new Date(), avatarKey: null };
const keyRow = (over: Record<string, unknown> = {}) => ({
  id: 'k',
  userId: 'u',
  name: 'Codex setup',
  keyHash: 'h',
  prefix: 'kn_12345678',
  scope: 'capture',
  workspaceId: null,
  projectIds: null,
  toolsets: null,
  expiresAt: new Date(Date.now() + 60_000),
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date(),
  oauthClientId: null,
  signInMethod: null,
  signInProviderId: null,
  purpose: 'install',
  user,
  ...over,
});

function resolver(row = keyRow()) {
  const prisma = { apiKey: { findUnique: vi.fn(async () => row), updateMany: vi.fn(async () => ({ count: 0 })) } };
  return new TokenAuthService(config, prisma as never, {} as never, {} as never);
}

describe('a setup key', () => {
  it('opens only a door that says install, the MCP endpoint included', async () => {
    await expect(resolver().resolve('kn_x')).rejects.toMatchObject({ status: 403, response: { reason: 'apiKeyInstallOnly' } });
    await expect(resolver().resolve('kn_x', { mcp: true })).rejects.toMatchObject({ status: 403, response: { reason: 'apiKeyInstallOnly' } });
    await expect(resolver().resolve('kn_x', { mcp: true, install: true })).resolves.toMatchObject({ apiKey: { id: 'k', scope: 'capture', install: true } });
    // An ordinary key is untouched by the mark.
    const plain = await resolver(keyRow({ purpose: null })).resolve('kn_x');
    expect(plain.apiKey).not.toHaveProperty('install');
  });

  it('stops at its hour like any expired key', async () => {
    await expect(resolver(keyRow({ expiresAt: new Date(Date.now() - 1) })).resolve('kn_x', { mcp: true, install: true })).rejects.toMatchObject({ status: 401 });
  });

  it('is admitted by exactly the six installer handlers, never by the class', () => {
    const reflector = new Reflector();
    const proto = McpController.prototype as unknown as Record<string, () => unknown>;
    const marked = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' && reflector.get(INSTALL_KEY_OK_META, proto[name]!) === true);
    expect(marked.sort()).toEqual(['captureKit', 'captureKitInstaller', 'setupInstaller', 'skill', 'skills', 'skillsInstaller']);
    expect(reflector.get(INSTALL_KEY_OK_META, McpController)).toBeUndefined();
  });
});

describe('minting a setup key', () => {
  function keys() {
    const created: Record<string, unknown>[] = [];
    const where: unknown[] = [];
    const prisma = {
      apiKey: {
        count: vi.fn(async (q: { where: unknown }) => (where.push(q.where), 0)),
        findMany: vi.fn(async (q: { where: unknown }) => (where.push(q.where), [])),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { ...keyRow(), ...data, createdAt: new Date() })),
      },
    };
    const service = new ApiKeysService(prisma as never, { record: vi.fn() } as never);
    return { service, created, where };
  }
  const session = { userId: 'u', mode: 'session', sessionId: 's' } as never;

  it('sets the purpose and an expiry of INSTALL_KEY_TTL_MINUTES, and says so in the list', async () => {
    const { service, created } = keys();
    const before = Date.now();
    const res = await service.create(session, { name: 'Codex setup', scope: 'capture', install: true });
    expect(created[0]).toMatchObject({ purpose: 'install' });
    const expires = (created[0]!.expiresAt as Date).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(INSTALL_KEY_TTL_MINUTES * 60_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(INSTALL_KEY_TTL_MINUTES * 60_000 + 1000);
    expect(res.key.install).toBe(true);
    expect(res.apiKey.startsWith('kn_')).toBe(true);
  });

  it('refuses a lifetime asked for beside it', async () => {
    await expect(keys().service.create(session, { name: 'x', install: true, expiresInDays: 30 })).rejects.toMatchObject({
      status: 400,
      response: { reason: 'install-key-expiry' },
    });
  });

  it('drops a spent setup key from the list and the cap, but keeps an ordinary expired key', async () => {
    const { service, where } = keys();
    await service.list(session);
    await service.create(session, { name: 'x' });
    for (const w of where) expect(w).toMatchObject({ userId: 'u', revokedAt: null, OR: [{ purpose: null }, { expiresAt: { gt: expect.any(Date) } }] });
  });
});

describe('the OAuth rendering of the client table', () => {
  const url = 'https://kb.test/v1/mcp';
  const base = { url, serverName: 'knowledge', auth: true, key: null };
  const keyed = mcpClients(base);
  const signedIn = mcpClients({ ...base, signIn: 'oauth' });

  it('carries no credential for a client that can sign in, and marks it', () => {
    const oauth = signedIn.filter((c) => c.oauth);
    expect(oauth.map((c) => c.id)).toEqual(keyed.filter((c) => c.signIn).map((c) => c.id));
    expect(oauth.length).toBe(14);
    for (const c of oauth) {
      const text = `${c.command ?? ''}\n${c.config.code}`;
      expect(text, c.id).not.toMatch(/Authorization|Bearer|bearer|KNOWLEDGE_API_KEY|api-key|input:/);
      expect(c.usesEnv, c.id).toBe(false);
    }
    expect(signedIn.find((c) => c.id === 'opencode')!.config.code).not.toContain('"oauth"');
    expect(signedIn.find((c) => c.id === 'hermes')!.config.code).toContain('auth: oauth');
    expect(signedIn.find((c) => c.id === 'claude-desktop')!.config.code).toBe(url);
  });

  it('keeps the key snippet for a client with no documented OAuth', () => {
    for (const id of ['deepseek', 'http']) {
      const c = signedIn.find((x) => x.id === id)!;
      expect(c.oauth, id).toBeUndefined();
      expect(c.config.code, id).toContain(KEY_ENV);
      expect(c).toEqual(keyed.find((x) => x.id === id));
    }
  });

  it('changes nothing when the person picks a key, or the server takes none', () => {
    expect(mcpClients({ ...base, signIn: 'key' })).toEqual(keyed);
    expect(mcpClients({ ...base, auth: false, signIn: 'oauth' })).toEqual(mcpClients({ ...base, auth: false }));
  });
});

describe('the setup script for a client that signs in', () => {
  const client = mcpClients({ url: 'https://kb.test/v1/mcp', serverName: 'knowledge', auth: true, key: null, signIn: 'oauth' }).find((c) => c.id === 'codex')!;
  const script = renderSetupInstaller({
    client,
    url: 'https://kb.test/v1/mcp',
    serverName: 'knowledge',
    auth: false,
    skillStack: null,
    skill: '# skill',
    kit: { skipped: 'declined' },
    project: null,
    sourceUrl: 'https://kb.test/v1/mcp/setup/install?client=codex&signIn=oauth',
  });

  it('asks for no key, registers with none and says how to sign in', () => {
    expect(script).not.toContain(`${KEY_ENV} is empty`);
    expect(script).toContain('codex mcp add knowledge --url https://kb.test/v1/mcp\n');
    expect(script).not.toContain('bearer-token-env-var');
    expect(script).toContain('In Codex, run codex mcp login knowledge: it opens your browser to sign you in.');
  });
});
