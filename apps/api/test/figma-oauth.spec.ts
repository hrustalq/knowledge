import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIGMA_GRANT_CONFIG_KEY, FIGMA_HANDLE_CONFIG_KEY, FIGMA_TOKEN_EXPIRES_CONFIG_KEY } from '@knowledge/contracts';

/**
 * Connect with Figma (#557): the off switch, PKCE and the signed state, the
 * code exchange, single-flight refresh, the callback's gate, and the
 * server-owned config keys. Figma is a mocked `safeFetch`; Postgres is an
 * in-memory stand-in that honours the guarded update.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../src/i18n/t.js', () => ({ t: (key: string) => key }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { decryptSecret, encryptSecret } = await import('../src/ai/secret-box.js');
const { signState } = await import('../src/connectors/github/github-jwt.js');
const { FigmaOauthService } = await import('../src/embeds/figma-oauth.service.js');
const { FigmaOauthController } = await import('../src/embeds/figma-oauth.controller.js');
const { withServerKeys } = await import('../src/connectors/connectors.service.js');
const mockFetch = vi.mocked(safeFetch);

const KEY = randomBytes(32);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Grant = { figmaUserId: string; accessToken: string; refreshToken: string; expiresAt: Date; refreshingUntil: Date | null; handle: string };

function setup(env: Record<string, unknown> = {}) {
  const grants = new Map<string, Grant>();
  const connectors = new Map<string, { id: string; workspaceId: string; kind: string; config: Record<string, unknown>; credential: string | null }>();
  const prisma = {
    figmaOauthGrant: {
      findUnique: async ({ where }: { where: { figmaUserId: string } }) => {
        const g = grants.get(where.figmaUserId);
        return g ? { ...g } : null;
      },
      // The guarded statement: token unchanged and no live lease, or nothing.
      updateMany: async ({ where, data }: { where: { figmaUserId: string; accessToken?: string; OR?: { refreshingUntil: { lt: Date } | null }[] }; data: Partial<Grant> }) => {
        const g = grants.get(where.figmaUserId);
        if (!g || (where.accessToken && g.accessToken !== where.accessToken)) return { count: 0 };
        const lt = (where.OR?.[1]?.refreshingUntil as { lt: Date } | undefined)?.lt;
        if (lt && g.refreshingUntil && g.refreshingUntil >= lt) return { count: 0 };
        Object.assign(g, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { figmaUserId: string }; data: Partial<Grant> }) => Object.assign(grants.get(where.figmaUserId)!, data),
      upsert: async ({ where, create, update }: { where: { figmaUserId: string }; create: Grant; update: Partial<Grant> }) =>
        grants.set(where.figmaUserId, grants.has(where.figmaUserId) ? { ...grants.get(where.figmaUserId)!, ...update } : create),
    },
    connector: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string; kind: string } }) => {
        const c = connectors.get(where.id);
        return c && c.workspaceId === where.workspaceId && c.kind === where.kind ? c : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(connectors.get(where.id)!, data),
    },
    // #564: a bound grant becomes the connector's `oauth` connection.
    connection: {
      upsert: vi.fn(async ({ create }: { create: { externalRef: string } }) => ({ id: `conn-${create.externalRef}` })),
    },
    $executeRaw: async () => 0,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  const settings: Record<string, unknown> = {
    FIGMA_OAUTH_CLIENT_ID: 'cid',
    FIGMA_OAUTH_CLIENT_SECRET: 'secret',
    SETTINGS_ENCRYPTION_KEY: KEY.toString('base64'),
    API_PUBLIC_URL: 'https://kb.test/api/',
    WEB_BASE_URL: 'https://kb.test',
    ...env,
  };
  const config = { get: (k: string) => settings[k] };
  const service = new FigmaOauthService(config as never, prisma as never);
  return { service, grants, connectors, config, prisma };
}

const stateOf = (url: string) => new URL(url).searchParams;

afterEach(() => mockFetch.mockReset());

describe('FigmaOauthService', () => {
  it('is off with the client id unset, and then offers nothing', async () => {
    const { service, grants } = setup({ FIGMA_OAUTH_CLIENT_ID: '' });
    grants.set('u1', { figmaUserId: 'u1', accessToken: 'x', refreshToken: 'y', expiresAt: new Date(0), refreshingUntil: null, handle: 'ada' });
    expect(service.configured).toBe(false);
    expect(service.authorizeUrl('ws', 'user', 'c1', '/x')).toBeNull();
    await expect(service.tokenFor('u1')).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('builds the authorize URL with scopes, the derived redirect URI and an S256 challenge', () => {
    const { service } = setup();
    const params = stateOf(service.authorizeUrl('ws', 'user', 'c1', '/settings/connectors/c1')!);
    expect(params.get('redirect_uri')).toBe('https://kb.test/api/v1/connectors/figma/callback');
    expect(params.get('scope')).toBe('folders:read file_content:read file_metadata:read current_user:read');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');

    const state = service.verify(params.get('state')!)!;
    expect(state).toMatchObject({ workspaceId: 'ws', userId: 'user', connectorId: 'c1' });
    const verifier = decryptSecret(state.pkce, KEY)!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(params.get('code_challenge'));
  });

  it('rejects a forged or expired state', () => {
    const { service } = setup();
    const raw = stateOf(service.authorizeUrl('ws', 'user', 'c1', '/x')!).get('state')!;
    expect(service.verify(raw.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
    const expired = signState({ workspaceId: 'ws', userId: 'u', returnTo: '/', nonce: 'n', exp: 1, connectorId: 'c1', pkce: 'p' }, KEY);
    expect(service.verify(expired)).toBeNull();
    const noConnector = signState({ workspaceId: 'ws', userId: 'u', returnTo: '/', nonce: 'n', exp: 9e9 }, KEY);
    expect(service.verify(noConnector)).toBeNull();
  });

  it('exchanges the code with Basic auth, a form body and the verifier, then binds the connector', async () => {
    const { service, grants, connectors } = setup();
    connectors.set('c1', { id: 'c1', workspaceId: 'ws', kind: 'figma', config: { allowlist: 'team:1', [FIGMA_TOKEN_EXPIRES_CONFIG_KEY]: '2027-01-01' }, credential: 'old' });
    const state = service.verify(stateOf(service.authorizeUrl('ws', 'user', 'c1', '/x')!).get('state')!)!;
    mockFetch
      .mockResolvedValueOnce(json({ access_token: 'at', refresh_token: 'rt', expires_in: 7_776_000, user_id_string: 'fig-1' }))
      .mockResolvedValueOnce(json({ handle: 'ada' }));

    await expect(service.completeAuthorization(state, 'code-1')).resolves.toBe(true);

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.figma.com/v1/oauth/token');
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init!.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toBe(decryptSecret(state.pkce, KEY));
    expect((mockFetch.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBe('Bearer at');

    expect(decryptSecret(grants.get('fig-1')!.accessToken, KEY)).toBe('at');
    expect(connectors.get('c1')).toMatchObject({
      credential: null,
      config: { allowlist: 'team:1', [FIGMA_GRANT_CONFIG_KEY]: 'fig-1', [FIGMA_HANDLE_CONFIG_KEY]: 'ada' },
      connectionId: 'conn-fig-1',
    });
    expect(connectors.get('c1')!.config).not.toHaveProperty(FIGMA_TOKEN_EXPIRES_CONFIG_KEY);
  });

  it('connects the workspace without a connector: the grant becomes an oauth connection', async () => {
    const { service, grants, prisma } = setup();
    const state = service.verify(stateOf(service.authorizeUrl('ws', 'user', null, '/x')!).get('state')!)!;
    expect(state.connectorId).toBeNull();
    mockFetch
      .mockResolvedValueOnce(json({ access_token: 'at', refresh_token: 'rt', expires_in: 7_776_000, user_id_string: 'fig-1' }))
      .mockResolvedValueOnce(json({ handle: 'ada' }));
    await expect(service.completeAuthorization(state, 'code-1')).resolves.toBe(true);
    expect(grants.has('fig-1')).toBe(true);
    expect(prisma.connection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_provider_method_externalRef: { workspaceId: 'ws', provider: 'figma', method: 'oauth', externalRef: 'fig-1' } },
        update: { accountId: 'fig-1', accountLabel: 'ada' },
      }),
    );
  });

  it('stores nothing when Figma refuses the code (a replayed state)', async () => {
    const { service, grants } = setup();
    const state = service.verify(stateOf(service.authorizeUrl('ws', 'user', 'c1', '/x')!).get('state')!)!;
    mockFetch.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(service.completeAuthorization(state, 'spent')).resolves.toBe(false);
    expect(grants.size).toBe(0);
  });

  it('makes one refresh call for two concurrent callers, and both get the new token', async () => {
    const { service, grants } = setup();
    grants.set('fig-1', {
      figmaUserId: 'fig-1',
      handle: 'ada',
      accessToken: encryptSecret('old', KEY),
      refreshToken: encryptSecret('rt', KEY),
      expiresAt: new Date(Date.now() - 1000),
      refreshingUntil: null,
    });
    mockFetch.mockImplementation(async () => json({ access_token: 'new', expires_in: 7_776_000 }));

    await expect(Promise.all([service.tokenFor('fig-1'), service.tokenFor('fig-1')])).resolves.toEqual(['new', 'new']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('https://api.figma.com/v1/oauth/refresh');
    expect(new URLSearchParams(String(mockFetch.mock.calls[0]![1]!.body)).get('refresh_token')).toBe('rt');
    expect(grants.get('fig-1')!.refreshingUntil).toBeNull();

    // A fresh token is returned as is; one Figma just refused is renewed.
    await expect(service.tokenFor('fig-1')).resolves.toBe('new');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockImplementation(async () => json({ access_token: 'newer', expires_in: 7_776_000 }));
    await expect(service.tokenFor('fig-1', 'new')).resolves.toBe('newer');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('the callback', () => {
  it('stores nothing for a missing or forged state', async () => {
    const { service, config } = setup();
    const complete = vi.spyOn(service, 'completeAuthorization');
    const controller = new FigmaOauthController(service, {} as never, config as never);
    const redirect = vi.fn();
    await controller.callback({ redirect } as never, 'forged.state', 'code');
    await controller.callback({ redirect } as never, undefined, 'code');
    expect(redirect.mock.calls).toEqual([['https://kb.test/oauth/figma?outcome=error'], ['https://kb.test/oauth/figma?outcome=error']]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('lands a completed flow on /oauth/figma with the signed return path', async () => {
    const { service, config } = setup();
    vi.spyOn(service, 'completeAuthorization').mockResolvedValue(true);
    const controller = new FigmaOauthController(service, {} as never, config as never);
    const redirect = vi.fn();
    const state = stateOf(service.authorizeUrl('ws', 'user', null, '/settings/connectors?add=1')!).get('state')!;
    await controller.callback({ redirect } as never, state, 'code');
    expect(redirect).toHaveBeenCalledWith('https://kb.test/oauth/figma?outcome=connected&returnTo=%2Fsettings%2Fconnectors%3Fadd%3D1');
  });
});

describe('withServerKeys', () => {
  it('keeps the stored grant whatever a request names', () => {
    const stored = { allowlist: 'team:1', [FIGMA_GRANT_CONFIG_KEY]: 'mine', [FIGMA_HANDLE_CONFIG_KEY]: 'ada' };
    expect(withServerKeys({ allowlist: 'team:2', [FIGMA_GRANT_CONFIG_KEY]: 'theirs' }, stored)).toEqual({
      allowlist: 'team:2',
      [FIGMA_GRANT_CONFIG_KEY]: 'mine',
      [FIGMA_HANDLE_CONFIG_KEY]: 'ada',
    });
    expect(withServerKeys({ allowlist: 'team:2', [FIGMA_GRANT_CONFIG_KEY]: 'theirs' }, {})).toEqual({ allowlist: 'team:2' });
  });
});
