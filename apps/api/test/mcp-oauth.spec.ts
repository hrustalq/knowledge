import { describe, expect, it, vi } from 'vitest';
import { AccessService } from '../src/auth/access.service.js';
import { policyFailure } from '../src/auth/auth-policy.service.js';
import { hashToken } from '../src/auth/auth-tokens.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { OAuthService, isCimdId, withParams } from '../src/oauth/oauth.service.js';

vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');

/**
 * OAuth for MCP clients (#1352, docs/features/33). What is pinned:
 *
 * 1. **A token is a key.** A `ko_` token resolves to the same `principal.apiKey`
 *    its grant row would as a key, so the key-narrowing rules hold unchanged —
 *    the cases of `mcp-http.spec.ts` are run here again with a token.
 * 2. **MCP only, and off means off.** Refused at every door that is not the MCP
 *    endpoint; with MCP_OAUTH_ENABLED=false it is an unknown credential.
 * 3. **SSO judges the sign-in, not the key.** `allowApiKeys` never lets a
 *    password sign-in through a client's token; the age cap counts from consent.
 * 4. **Codes and refresh tokens are single use**, and a replay ends the grant.
 */

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const PROVIDER = '44444444-4444-4444-8444-444444444444';
const API = 'https://kb.example.com/api';
const env: Record<string, unknown> = { AUTH_MODE: 'api-key', MCP_OAUTH_ENABLED: true, API_PUBLIC_URL: API, WEB_BASE_URL: 'https://kb.example.com' };
const config = (over: Record<string, unknown> = {}) => ({ get: (k: string) => ({ ...env, ...over })[k] }) as never;

const user = { id: 'u', email: 'a@example.com', displayName: 'Ada', isAdmin: false, locale: 'en', disabledAt: null, emailVerifiedAt: new Date(), avatarKey: null };
const grantRow = (over: Record<string, unknown> = {}) => ({
  id: 'g',
  userId: 'u',
  name: 'Claude',
  keyHash: null,
  prefix: 'oauth',
  scope: 'write',
  workspaceId: null,
  projectIds: null,
  toolsets: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date(),
  oauthClientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  signInMethod: 'oidc',
  signInProviderId: PROVIDER,
  ...over,
});

/** A real TokenAuthService over one stored grant and one of its tokens. */
function resolver(grant = grantRow(), token: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const prisma = {
    oAuthToken: { findUnique: vi.fn(async () => ({ kind: 'access', expiresAt: new Date(Date.now() + 60_000), ...token, apiKey: { ...grant, user } })) },
    apiKey: { findUnique: vi.fn(async () => ({ ...grant, keyHash: 'h', oauthClientId: null, user })), updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  return new TokenAuthService(config(over), prisma as never, {} as never, {} as never);
}

function accessWith(role: 'viewer' | 'editor' | 'admin' | null) {
  const prisma = {
    workspaceMember: { findUnique: vi.fn(async () => (role ? { role, trustedOperator: false } : null)) },
    workspace: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
  };
  return new AccessService(prisma as never, { enforce: async () => undefined } as never);
}

describe('a ko_ token resolves like the key its grant would be', () => {
  it('carries the same narrowing as the same row read as a key, plus the grant', async () => {
    const grant = grantRow({ scope: 'capture', workspaceId: WS_A, projectIds: ['p1'], toolsets: ['core', 'graph'] });
    const viaToken = await resolver(grant).resolve('ko_x', { mcp: true });
    const viaKey = await resolver(grant).resolve('kn_x', { mcp: true });
    const { oauth, ...narrowing } = viaToken.apiKey!;
    expect(narrowing).toEqual(viaKey.apiKey);
    expect(oauth).toMatchObject({ clientId: grant.oauthClientId, signInMethod: 'oidc', signInProviderId: PROVIDER });
    expect(viaToken).toMatchObject({ userId: 'u', mode: 'api-key' });
  });

  it('is MCP-only: refused wherever a bearer is resolved, unless the route is the MCP endpoint', async () => {
    await expect(resolver().resolve('ko_x')).rejects.toMatchObject({ status: 403, response: { reason: 'apiKeyMcpOnly' } });
    await expect(resolver().resolve('ko_x', { mcp: true })).resolves.toMatchObject({ apiKey: { id: 'g' } });
  });

  it('stops on its next call once the grant is revoked or past its end, and never takes a refresh token or a stale one', async () => {
    await expect(resolver(grantRow({ revokedAt: new Date() })).resolve('ko_x', { mcp: true })).rejects.toMatchObject({ status: 401 });
    await expect(resolver(grantRow({ expiresAt: new Date(Date.now() - 1) })).resolve('ko_x', { mcp: true })).rejects.toMatchObject({ status: 401 });
    await expect(resolver(grantRow(), { kind: 'refresh' }).resolve('ko_x', { mcp: true })).rejects.toMatchObject({ status: 401 });
    await expect(resolver(grantRow(), { expiresAt: new Date(Date.now() - 1) }).resolve('ko_x', { mcp: true })).rejects.toMatchObject({ status: 401 });
    // A key row (no client) behind a token is not a grant.
    await expect(resolver(grantRow({ oauthClientId: null })).resolve('ko_x', { mcp: true })).rejects.toMatchObject({ status: 401 });
  });

  it('is an unknown credential while MCP_OAUTH_ENABLED is off, and the 401 then points nowhere', async () => {
    const off = resolver(grantRow(), {}, { MCP_OAUTH_ENABLED: false });
    await expect(off.resolve('ko_x', { mcp: true })).rejects.toMatchObject({ status: 401 });
    expect(off.mcpChallenge()).toBeNull();
    expect(resolver().mcpChallenge()).toBe('Bearer resource_metadata="https://kb.example.com/.well-known/oauth-protected-resource/api/v1/mcp"');
  });

  it('meets the key-narrowing rules of mcp-http.spec.ts unchanged', async () => {
    const read = await resolver(grantRow({ scope: 'read' })).resolve('ko_x', { mcp: true });
    await expect(accessWith('editor').requireRole(read, WS_A, 'viewer')).resolves.toBeUndefined();
    await expect(accessWith('editor').requireRole(read, WS_A, 'editor')).rejects.toThrow(/apiKeyReadOnly/);
    // Before the platform-admin shortcut.
    await expect(accessWith(null).requireRole({ ...read, isAdmin: true }, WS_A, 'admin')).rejects.toThrow(/apiKeyReadOnly/);
    const pinned = await resolver(grantRow({ workspaceId: WS_A })).resolve('ko_x', { mcp: true });
    await expect(accessWith('admin').requireRole(pinned, WS_A, 'admin')).resolves.toBeUndefined();
    await expect(accessWith('admin').requireRole(pinned, WS_B, 'viewer')).rejects.toThrow(/apiKeyWorkspace/);
    const write = await resolver().resolve('ko_x', { mcp: true });
    await expect(accessWith('viewer').requireRole(write, WS_A, 'editor')).rejects.toThrow(/roleRequired/);
    const capture = await resolver(grantRow({ scope: 'capture' })).resolve('ko_x', { mcp: true });
    await expect(accessWith('admin').requireRole(capture, WS_A, 'editor')).rejects.toThrow(/apiKeyCaptureOnly/);
    await expect(accessWith('admin').requireRole(capture, WS_A, 'editor', false, { capture: true })).resolves.toBeUndefined();
  });
});

describe('enforced SSO judges a grant as the sign-in that approved it', () => {
  const policy = (over: Partial<Parameters<typeof policyFailure>[1]> = {}) => ({
    ssoEnforced: true,
    allowApiKeys: true,
    allowPasswordForAdmins: false,
    sessionMaxAgeHours: null,
    providers: [{ id: PROVIDER }],
    ...over,
  });
  const viaGrant = async (over: Record<string, unknown>) => resolver(grantRow(over)).resolve('ko_x', { mcp: true });

  it('refuses a grant made through a password sign-in even where keys are allowed', async () => {
    expect(policyFailure(await viaGrant({ signInMethod: 'password', signInProviderId: null }), policy())).toBe('password-session');
    expect(policyFailure(await viaGrant({ signInProviderId: '99999999-9999-4999-8999-999999999999' }), policy())).toBe('foreign-provider');
    expect(policyFailure(await viaGrant({}), policy())).toBeNull();
    // A key is still the key rule: allowed here, blocked when keys are not.
    const key = await resolver().resolve('kn_x', { mcp: true });
    expect(policyFailure(key, policy())).toBeNull();
    expect(policyFailure(key, policy({ allowApiKeys: false }))).toBe('api-key');
  });

  it('counts the age cap from consent', async () => {
    const old = await viaGrant({ createdAt: new Date(Date.now() - 13 * 3_600_000) });
    expect(policyFailure(old, policy({ sessionMaxAgeHours: 12 }))).toBe('session-too-old');
    expect(policyFailure(await viaGrant({}), policy({ sessionMaxAgeHours: 12 }))).toBeNull();
  });
});

/** An in-memory slice of the four tables the authorization server writes. */
function store() {
  const requests = new Map<string, Record<string, any>>();
  const tokens = new Map<string, Record<string, any>>();
  const keys = new Map<string, Record<string, any>>([['g', { ...grantRow(), user }]]);
  const match = (row: Record<string, any>, where: Record<string, any>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Record<string, any>[]).some((w) => match(row, w));
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('gt' in v) return row[k] != null && row[k] > v.gt;
        if ('lt' in v) return row[k] != null && row[k] < v.lt;
      }
      return row[k] === v;
    });
  const table = (rows: Map<string, Record<string, any>>) => ({
    findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => {
      const row = [...rows.values()].find((r) => match(r, where));
      return row && { ...row, apiKey: keys.get(row.apiKeyId) };
    }),
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      const row = { id: `r${rows.size}`, spentAt: null, apiKeyId: null, codeHash: null, ...data };
      rows.set(row.id, row);
      return row;
    }),
    createMany: vi.fn(async ({ data }: { data: Record<string, any>[] }) => {
      for (const d of data) rows.set(`t${rows.size}`, { id: `t${rows.size}`, spentAt: null, ...d });
      return { count: data.length };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const hit = [...rows.values()].filter((r) => match(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
      const hit = [...rows.entries()].filter(([, r]) => match(r, where));
      for (const [id] of hit) rows.delete(id);
      return { count: hit.length };
    }),
  });
  const prisma = {
    oAuthRequest: table(requests),
    oAuthToken: table(tokens),
    apiKey: { ...table(keys), findUnique: vi.fn(async ({ where }: { where: { id: string } }) => keys.get(where.id) ?? null) },
    oAuthClient: { findUnique: vi.fn(async () => null), upsert: vi.fn(async ({ create }: { create: Record<string, any> }) => ({ ...create, createdAt: new Date() })) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const audit = { record: vi.fn() };
  return { prisma, requests, tokens, keys, audit, oauth: new OAuthService(prisma as never, audit as never, {} as never, {} as never, config()) };
}

const CLIENT = { client_id: 'https://claude.ai/oauth/claude-code-client-metadata', redirect_uris: ['http://localhost/callback'] };

/** A request the consent screen approved: the code is bound to it, as the controller binds it. */
function approved(s: ReturnType<typeof store>, code = 'koc_code') {
  s.requests.set('q', {
    id: 'q',
    clientId: CLIENT.client_id,
    redirectUri: 'http://localhost:3118/callback',
    codeChallenge: 'challenge',
    apiKeyId: 'g',
    codeHash: hashToken(code),
    expiresAt: new Date(Date.now() + 60_000),
    spentAt: null,
  });
  return code;
}

describe('the authorization server', () => {
  it('redeems a code once; a second redemption ends the grant the first one got', async () => {
    const s = store();
    const code = approved(s);
    expect(await s.oauth.challengeForAuthorizationCode(CLIENT, code)).toBe('challenge');
    const tokens = await s.oauth.exchangeAuthorizationCode(CLIENT, code, 'v', 'http://localhost:3118/callback');
    expect(tokens.access_token).toMatch(/^ko_/);
    expect(tokens.refresh_token).toMatch(/^kor_/);
    expect(tokens.expires_in).toBeLessThanOrEqual(3600);
    // Only hashes are stored.
    expect([...s.tokens.values()].map((t) => t.tokenHash)).toContain(hashToken(tokens.access_token));
    await expect(s.oauth.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow(/already used/);
    expect(s.keys.get('g')!.revokedAt).toBeInstanceOf(Date);
    expect(s.tokens.size).toBe(0);
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'oauth.revoked', params: expect.objectContaining({ reason: 'code-replayed' }) }));
  });

  it("refuses a code to another client, another redirect, or another server's resource", async () => {
    const s = store();
    const code = approved(s);
    await expect(s.oauth.challengeForAuthorizationCode({ ...CLIENT, client_id: 'other' }, code)).rejects.toThrow(/Invalid authorization code/);
    await expect(s.oauth.exchangeAuthorizationCode(CLIENT, code, 'v', 'http://localhost:9999/elsewhere')).rejects.toThrow(/Invalid authorization code/);
    await expect(s.oauth.exchangeAuthorizationCode(CLIENT, code, 'v', undefined, new URL('https://evil.example/mcp'))).rejects.toThrow(/issues tokens for/);
    await expect(s.oauth.exchangeAuthorizationCode(CLIENT, code, 'v', undefined, new URL(`${API}/v1/mcp`))).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('rotates refresh tokens, and a reused one ends the grant', async () => {
    const s = store();
    const first = await s.oauth.exchangeAuthorizationCode(CLIENT, approved(s));
    const second = await s.oauth.exchangeRefreshToken(CLIENT, first.refresh_token!);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(s.oauth.exchangeRefreshToken({ ...CLIENT, client_id: 'other' }, second.refresh_token!)).rejects.toThrow(/Invalid refresh token/);
    await expect(s.oauth.exchangeRefreshToken(CLIENT, first.refresh_token!)).rejects.toThrow(/already used/);
    expect(s.keys.get('g')!.revokedAt).toBeInstanceOf(Date);
    await expect(s.oauth.exchangeRefreshToken(CLIENT, second.refresh_token!)).rejects.toThrow();
  });

  it('never issues past the grant: a revoked, ended or disabled grant refreshes nothing, and the access token stops at its end', async () => {
    const s = store();
    const first = await s.oauth.exchangeAuthorizationCode(CLIENT, approved(s));
    s.keys.get('g')!.revokedAt = new Date();
    await expect(s.oauth.exchangeRefreshToken(CLIENT, first.refresh_token!)).rejects.toThrow(/grant has ended/);

    const t = store();
    const end = new Date(Date.now() + 600_000);
    Object.assign(t.keys.get('g')!, { expiresAt: end });
    const tokens = await t.oauth.exchangeAuthorizationCode(CLIENT, approved(t));
    expect(tokens.expires_in).toBeLessThanOrEqual(600);
    expect([...t.tokens.values()].find((x) => x.kind === 'refresh')!.expiresAt).toEqual(end);
  });

  it('revocation by the client ends the whole grant, and ignores another client', async () => {
    const s = store();
    const tokens = await s.oauth.exchangeAuthorizationCode(CLIENT, approved(s));
    await s.oauth.revokeToken({ ...CLIENT, client_id: 'other' }, { token: tokens.access_token });
    expect(s.keys.get('g')!.revokedAt).toBeNull();
    await s.oauth.revokeToken(CLIENT, { token: tokens.access_token });
    expect(s.keys.get('g')!.revokedAt).toBeInstanceOf(Date);
  });

  it('starts a pending request and sends the browser to the consent screen', async () => {
    const s = store();
    const res = { redirect: vi.fn() };
    await s.oauth.authorize(CLIENT, { codeChallenge: 'c', redirectUri: 'http://localhost:3118/callback', state: 'st' }, res as never);
    const [row] = [...s.requests.values()];
    expect(row).toMatchObject({ clientId: CLIENT.client_id, codeChallenge: 'c', state: 'st', apiKeyId: null, codeHash: null });
    expect(res.redirect).toHaveBeenCalledWith(302, `https://kb.example.com/oauth/authorize?request=${row.id}`);
    await expect(
      s.oauth.authorize(CLIENT, { codeChallenge: 'c', redirectUri: 'http://localhost/callback', resource: new URL('https://evil.example/mcp') }, res as never),
    ).rejects.toThrow(/issues tokens for/);
  });
});

describe('Client ID Metadata Documents', () => {
  const doc = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ client_id: CLIENT.client_id, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], ...over }), {
      headers: { 'cache-control': 'max-age=3600' },
    });

  it('recognises a URL client id only with a path', () => {
    expect(isCimdId(CLIENT.client_id)).toBe(true);
    expect(isCimdId('https://claude.ai/')).toBe(false);
    expect(isCimdId('http://claude.ai/client.json')).toBe(false);
    expect(isCimdId('0b6c…uuid')).toBe(false);
  });

  it('fetches, checks and caches a document that names itself', async () => {
    const s = store();
    vi.mocked(safeFetch).mockResolvedValueOnce(doc());
    const client = await s.oauth.getClient(CLIENT.client_id);
    expect(client).toMatchObject({ client_id: CLIENT.client_id, client_name: 'Claude Code', token_endpoint_auth_method: 'none' });
    expect(vi.mocked(safeFetch).mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(s.prisma.oAuthClient.upsert).toHaveBeenCalled();
  });

  it('refuses a document that names another client, lists no redirect, or is a confidential client', async () => {
    for (const bad of [{ client_id: 'https://evil.example/client.json' }, { redirect_uris: [] }, { token_endpoint_auth_method: 'client_secret_basic' }]) {
      vi.mocked(safeFetch).mockResolvedValueOnce(doc(bad));
      expect(await store().oauth.getClient(CLIENT.client_id)).toBeUndefined();
    }
  });
});

describe('withParams', () => {
  it('keeps the query a registered redirect already has', () => {
    expect(withParams('https://claude.ai/api/mcp/auth_callback?x=1', { code: 'c', state: null })).toBe('https://claude.ai/api/mcp/auth_callback?x=1&code=c');
    expect(withParams('cursor://anysphere.cursor-mcp/oauth/callback', { error: 'access_denied', state: 's' })).toBe(
      'cursor://anysphere.cursor-mcp/oauth/callback?error=access_denied&state=s',
    );
  });
});
