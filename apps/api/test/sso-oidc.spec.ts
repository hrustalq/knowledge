import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { identityFromClaims } from '../src/auth/sso/oidc-claims.js';
import { OidcService } from '../src/auth/sso/oidc.service.js';
import { SsoFlowService } from '../src/auth/sso/sso-flow.service.js';
import { SsoLoginService } from '../src/auth/sso/sso-login.service.js';
import { normalizeDomain } from '../src/auth/sso/identity-providers.service.js';
import { safeReturnTo } from '../src/common/safe-return-to.js';

/**
 * OIDC sign-in end to end (#75 phase 2), against an in-process OpenID provider:
 * discovery, code + PKCE, a signed id_token, the single-use transaction, JIT,
 * the linking rules, and the fragment code the web trades for a session.
 * Everything but the database is real — `openid-client`, the HTTP round trips,
 * the signature checks.
 */

// ---------------------------------------------------------------- mock OP

interface Grant {
  challenge: string;
  clientId: string;
  redirectUri: string;
  claims: Record<string, unknown>;
}

const op = {
  server: null as Server | null,
  issuer: '',
  kid: 'k1',
  privateKey: null as unknown as CryptoKey,
  jwk: null as unknown as JWK,
  grants: new Map<string, Grant>(),
  tokenCalls: 0,
};

async function idToken(claims: Record<string, unknown>, audience: string): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: op.kid })
    .setIssuer(op.issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(op.privateKey);
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d)).on('end', () => resolve(s));
  });
}

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  op.privateKey = privateKey as CryptoKey;
  op.jwk = { ...(await exportJWK(publicKey)), kid: op.kid, alg: 'RS256', use: 'sig' };
  op.server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', op.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: op.issuer,
        authorization_endpoint: `${op.issuer}/authorize`,
        token_endpoint: `${op.issuer}/token`,
        jwks_uri: `${op.issuer}/jwks`,
        userinfo_endpoint: `${op.issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [op.jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      op.tokenCalls++;
      const form = new URLSearchParams(await readBody(req));
      const grant = op.grants.get(form.get('code') ?? '');
      if (!grant) return json(400, { error: 'invalid_grant' });
      op.grants.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: `at_${randomUUID()}`,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: await idToken(grant.claims, grant.clientId),
      });
    }
    json(404, {});
  });
  await new Promise<void>((r) => op.server!.listen(0, '127.0.0.1', () => r()));
  op.issuer = `http://127.0.0.1:${(op.server!.address() as AddressInfo).port}`;
});

afterAll(() => op.server?.close());

/** The IdP's half of the browser round trip: authorize the request the start URL describes. */
function authorize(startUrl: string, claims: Record<string, unknown>, overrides: { nonce?: string } = {}): URLSearchParams {
  const u = new URL(startUrl);
  expect(u.origin + u.pathname).toBe(`${op.issuer}/authorize`);
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  const code = randomUUID();
  op.grants.set(code, {
    challenge: u.searchParams.get('code_challenge')!,
    clientId: u.searchParams.get('client_id')!,
    redirectUri: u.searchParams.get('redirect_uri')!,
    claims: { nonce: overrides.nonce ?? u.searchParams.get('nonce'), ...claims },
  });
  return new URLSearchParams({ code, state: u.searchParams.get('state')! });
}

// ---------------------------------------------------------------- fakes

const WS = '22222222-2222-4222-8222-222222222222';
const API = 'http://api.test';
const WEB = 'http://web.test';

function fakeConfig(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    AUTH_SSO_ALLOW_PRIVATE_URLS: true,
    API_PUBLIC_URL: API,
    WEB_BASE_URL: WEB,
    AUTH_SSO_STATE_TTL_SEC: 600,
    SETTINGS_ENCRYPTION_KEY: '',
    AUTH_PASSWORD_LOGIN_ENABLED: true,
    AUTH_BREAK_GLASS_EMAILS: '',
    AUTH_SESSION_TTL_HOURS: 720,
    NODE_ENV: 'test',
    ...over,
  };
  return { get: (k: string) => values[k] };
}

type Row = Record<string, any>;

/** Just enough of Prisma for the SSO tables, in memory, with the unique indexes that matter. */
function fakePrisma() {
  const db = {
    providers: [] as Row[],
    requests: [] as Row[],
    identities: [] as Row[],
    users: [] as Row[],
    members: [] as Row[],
  };
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'kind' && v && typeof v === 'object' && 'in' in v) return (v.in as string[]).includes(row.kind);
      if (k === 'allowedDomains' && v && typeof v === 'object') return row.allowedDomains.includes(v.has);
      if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
      return row[k] === v;
    });
  const prisma = {
    identityProvider: {
      findFirst: vi.fn(async ({ where }: Row) => db.providers.find((p) => match(p, where)) ?? null),
      findMany: vi.fn(async ({ where }: Row) => db.providers.filter((p) => match(p, where))),
    },
    ssoAuthRequest: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: randomUUID(), consumedAt: null, exchangeCodeHash: null, userId: null, idpSessionId: null, ...data };
        db.requests.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: Row) => {
        const row = db.requests.find((r) => (where.stateHash ? r.stateHash === where.stateHash : r.exchangeCodeHash === where.exchangeCodeHash));
        return row ? { ...row, provider: db.providers.find((p) => p.id === row.providerId) } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = db.requests.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(db.requests.find((r) => r.id === where.id)!, data)),
    },
    userIdentity: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const { providerId, subject } = where.providerId_subject;
        const row = db.identities.find((i) => i.providerId === providerId && i.subject === subject);
        return row ? { ...row, user: db.users.find((u) => u.id === row.userId) } : null;
      }),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: randomUUID(), ...data };
        db.identities.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    user: {
      findUnique: vi.fn(async ({ where }: Row) => db.users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null),
      create: vi.fn(async ({ data }: Row) => {
        const { identities, ...rest } = data;
        const user = { id: randomUUID(), isAdmin: false, disabledAt: null, avatarKey: null, avatarUpdatedAt: null, ...rest };
        db.users.push(user);
        if (identities?.create) db.identities.push({ id: randomUUID(), userId: user.id, ...identities.create });
        return user;
      }),
    },
    workspaceMember: {
      createMany: vi.fn(async ({ data }: Row) => {
        for (const m of data as Row[]) {
          if (!db.members.some((x) => x.workspaceId === m.workspaceId && x.userId === m.userId)) db.members.push(m);
        }
        return { count: 1 };
      }),
      findMany: vi.fn(async ({ where }: Row) => db.members.filter((m) => m.userId === where.userId).map((m) => ({ trustedOperator: false, ...m }))),
    },
  };
  return { prisma, db };
}

function harness(config = fakeConfig()) {
  const { prisma, db } = fakePrisma();
  const audit = { record: vi.fn(async () => undefined) };
  const sessions = {
    create: vi.fn(async (_userId: string, _meta: Row) => ({
      token: `ks_${randomUUID()}`,
      session: { id: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) },
    })),
  };
  const oidc = new OidcService(config as never);
  const login = new SsoLoginService(prisma as never, audit as never);
  const flow = new AuthFlowService(prisma as never, config as never, sessions as never, {} as never, audit as never);
  const sso = new SsoFlowService(prisma as never, config as never, oidc, login, flow, audit as never);

  const provider = (over: Row = {}) => {
    const row = {
      id: randomUUID(),
      workspaceId: WS,
      kind: 'oidc',
      preset: 'keycloak',
      name: 'Keycloak',
      enabled: true,
      showOnLogin: true,
      platformWide: false,
      config: { issuer: op.issuer, clientId: 'knowledge', scopes: [] },
      secretCipher: null,
      jitEnabled: true,
      defaultRole: 'editor',
      allowedDomains: ['corp.example'],
      groupsClaim: null,
      groupSyncMode: 'additive',
      sessionTtlHours: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
    db.providers.push(row);
    return row;
  };
  const failures = () => (audit.record.mock.calls as unknown as Row[][]).map((c) => c[0]).filter((e) => e.action === 'auth.login_failed');
  return { sso, oidc, prisma, db, audit, sessions, provider, failures };
}

const meta = { ip: '203.0.113.9', userAgent: 'Browser/1' };
const person = (over: Row = {}) => ({ sub: 'kc-1', email: 'ada@corp.example', email_verified: true, name: 'Ada L', sid: 'idp-sess-1', ...over });

/** start → IdP → callback, as the browser would; returns where the callback sent it. */
async function signIn(h: ReturnType<typeof harness>, providerId: string, claims: Row, opts: { returnTo?: string; nonce?: string } = {}) {
  const start = await h.sso.start(providerId, opts.returnTo ?? '/documents');
  const back = authorize(start, claims, { nonce: opts.nonce });
  return h.sso.callback(providerId, back, meta);
}

const fragmentCode = (redirect: string): string | null => {
  const m = redirect.match(/^http:\/\/web\.test\/auth\/sso\/complete#code=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
};

// ---------------------------------------------------------------- tests

describe('OIDC sign-in', () => {
  beforeEach(() => op.grants.clear());

  it('JIT-creates an SSO-only account, links the identity, grants the default role, and opens an oidc session on exchange', async () => {
    const h = harness();
    const p = h.provider();
    const redirect = await signIn(h, p.id, person(), { returnTo: '/documents/abc' });

    const code = fragmentCode(redirect);
    expect(code).toBeTruthy();
    // No session exists yet, and the redirect carries no token — only the fragment code.
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(redirect).not.toMatch(/ks_/);

    expect(h.db.users).toHaveLength(1);
    expect(h.db.users[0]).toMatchObject({ email: 'ada@corp.example', passwordHash: null, displayName: 'Ada L' });
    expect(h.db.identities[0]).toMatchObject({ providerId: p.id, subject: 'kc-1', userId: h.db.users[0].id });
    expect(h.db.members).toEqual([{ workspaceId: WS, userId: h.db.users[0].id, role: 'editor', source: 'jit' }]);

    const res = await h.sso.exchange(code!, meta);
    expect(res.returnTo).toBe('/documents/abc');
    expect(res.me.authMethod).toBe('oidc');
    expect(res.token).toMatch(/^ks_/);
    expect(h.sessions.create).toHaveBeenCalledWith(h.db.users[0].id, {
      authMethod: 'oidc',
      providerId: p.id,
      idpSessionId: 'idp-sess-1',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const actions = (h.audit.record.mock.calls as unknown as Row[][]).map((c) => c[0]);
    expect(actions.find((e) => e.action === 'auth.login')).toMatchObject({ workspaceId: WS, params: { method: 'oidc', via: 'sso', providerId: p.id } });
    expect(actions.find((e) => e.action === 'sso.jit_user_created')).toMatchObject({ workspaceId: WS });
  });

  it('a second sign-in reuses the account and the identity link', async () => {
    const h = harness();
    const p = h.provider();
    await h.sso.exchange(fragmentCode(await signIn(h, p.id, person()))!, meta);
    // The address changed at the IdP; the subject is what identifies the person.
    await h.sso.exchange(fragmentCode(await signIn(h, p.id, person({ email: 'ada.l@corp.example' })))!, meta);
    expect(h.db.users).toHaveLength(1);
    expect(h.db.identities).toHaveLength(1);
  });

  it('a reused exchange code is refused', async () => {
    const h = harness();
    const p = h.provider();
    const code = fragmentCode(await signIn(h, p.id, person()))!;
    await h.sso.exchange(code, meta);
    await expect(h.sso.exchange(code, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.sso.exchange('forged', meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an expired exchange code is refused', async () => {
    const h = harness();
    const p = h.provider();
    const code = fragmentCode(await signIn(h, p.id, person()))!;
    h.db.requests[0].expiresAt = new Date(Date.now() - 1);
    await expect(h.sso.exchange(code, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a replayed state fails to /login?error=invalid-state with an audit row, and redeems no second code', async () => {
    const h = harness();
    const p = h.provider();
    const start = await h.sso.start(p.id, '/documents');
    const back = authorize(start, person());
    expect(fragmentCode(await h.sso.callback(p.id, back, meta))).toBeTruthy();
    const calls = op.tokenCalls;

    const again = await h.sso.callback(p.id, back, meta);
    expect(again).toBe(`${WEB}/login?error=invalid-state`);
    expect(op.tokenCalls).toBe(calls);
    expect(h.failures().at(-1)).toMatchObject({ workspaceId: WS, ok: false, error: 'state replayed', params: { method: 'oidc', error: 'invalid-state' } });
  });

  it.each([
    ['forged', (q: URLSearchParams) => q.set('state', 'not-a-state')],
    ['missing', (q: URLSearchParams) => q.delete('state')],
  ])('a %s state fails to /login?error=invalid-state', async (_label, tamper) => {
    const h = harness();
    const p = h.provider();
    const back = authorize(await h.sso.start(p.id, '/documents'), person());
    tamper(back);
    expect(await h.sso.callback(p.id, back, meta)).toBe(`${WEB}/login?error=invalid-state`);
    expect(h.failures()).toHaveLength(1);
  });

  it('an expired transaction fails, keeping where the person was going', async () => {
    const h = harness();
    const p = h.provider();
    const back = authorize(await h.sso.start(p.id, '/projects/x'), person());
    h.db.requests[0].expiresAt = new Date(Date.now() - 1);
    expect(await h.sso.callback(p.id, back, meta)).toBe(`${WEB}/login?error=invalid-state&redirect=%2Fprojects%2Fx`);
  });

  it("a state from another provider's transaction fails", async () => {
    const h = harness();
    const a = h.provider();
    const b = h.provider({ name: 'Other' });
    const back = authorize(await h.sso.start(a.id, '/documents'), person());
    expect(await h.sso.callback(b.id, back, meta)).toBe(`${WEB}/login?error=invalid-state`);
  });

  it('a wrong nonce in the id_token fails with id-token-invalid', async () => {
    const h = harness();
    const p = h.provider();
    const redirect = await signIn(h, p.id, person(), { nonce: 'attacker-nonce' });
    expect(redirect).toBe(`${WEB}/login?error=id-token-invalid`);
    expect(h.db.users).toHaveLength(0);
    expect(h.failures()[0]).toMatchObject({ ok: false, params: { error: 'id-token-invalid' } });
  });

  it("an IdP error comes back as provider-error, with the IdP's words kept for the audit row only", async () => {
    const h = harness();
    const p = h.provider();
    const u = new URL(await h.sso.start(p.id, '/documents'));
    const back = new URLSearchParams({ state: u.searchParams.get('state')!, error: 'access_denied', error_description: 'User cancelled' });
    expect(await h.sso.callback(p.id, back, meta)).toBe(`${WEB}/login?error=provider-error`);
    expect(h.failures()[0].error).toBe('access_denied: User cancelled');
  });

  it('JIT off refuses a first-time person with jit-disabled', async () => {
    const h = harness();
    const p = h.provider({ jitEnabled: false });
    expect(await signIn(h, p.id, person())).toBe(`${WEB}/login?error=jit-disabled`);
    expect(h.db.users).toHaveLength(0);
  });

  it('JIT never creates an account for an unverified address or a foreign domain', async () => {
    const h = harness();
    const p = h.provider();
    expect(await signIn(h, p.id, person({ email_verified: false }))).toBe(`${WEB}/login?error=email-not-verified`);
    expect(await signIn(h, p.id, person({ sub: 'kc-2', email: 'eve@elsewhere.example' }))).toBe(`${WEB}/login?error=domain-not-allowed`);
    expect(h.db.users).toHaveLength(0);
  });

  describe('linking to an existing account', () => {
    const existing = (h: ReturnType<typeof harness>, email = 'ada@corp.example') => {
      const user = { id: randomUUID(), email, displayName: 'Ada', passwordHash: 'scrypt$x', isAdmin: false, disabledAt: null, emailVerifiedAt: null, locale: 'en', avatarKey: null, avatarUpdatedAt: null };
      h.db.users.push(user);
      return user;
    };

    it('links a verified address on an allowed domain, and audits the link', async () => {
      const h = harness();
      const p = h.provider({ jitEnabled: false });
      const user = existing(h);
      const res = await h.sso.exchange(fragmentCode(await signIn(h, p.id, person()))!, meta);
      expect(res.me.userId).toBe(user.id);
      expect(h.db.identities).toEqual([expect.objectContaining({ userId: user.id, providerId: p.id, subject: 'kc-1' })]);
      expect(h.db.users[0].passwordHash).toBe('scrypt$x');
      expect((h.audit.record.mock.calls as unknown as Row[][]).some((c) => c[0].action === 'sso.identity_linked')).toBe(true);
    });

    it('never links on an unverified address — the takeover the rule exists for', async () => {
      const h = harness();
      const p = h.provider();
      const user = existing(h);
      expect(await signIn(h, p.id, person({ email_verified: false }))).toBe(`${WEB}/login?error=email-not-verified`);
      expect(h.db.identities).toHaveLength(0);
      expect(h.failures()[0].target).toBe(user.id);
    });

    it('never links an address on a domain the provider may not assert', async () => {
      const h = harness();
      const p = h.provider();
      existing(h, 'ada@elsewhere.example');
      expect(await signIn(h, p.id, person({ email: 'ada@elsewhere.example' }))).toBe(`${WEB}/login?error=domain-not-allowed`);
      expect(h.db.identities).toHaveLength(0);
    });

    it('refuses a disabled account, and leaves an existing membership alone', async () => {
      const h = harness();
      const p = h.provider();
      const user = existing(h);
      h.db.members.push({ workspaceId: WS, userId: user.id, role: 'admin', source: 'manual' });
      await h.sso.exchange(fragmentCode(await signIn(h, p.id, person()))!, meta);
      expect(h.db.members).toEqual([{ workspaceId: WS, userId: user.id, role: 'admin', source: 'manual' }]);

      user.disabledAt = new Date() as never;
      expect(await signIn(h, p.id, person())).toBe(`${WEB}/login?error=account-disabled`);
    });
  });

  it('collapses a returnTo that would leave the web app', async () => {
    const h = harness();
    const p = h.provider();
    for (const evil of ['https://evil.example/x', '//evil.example', '/\\evil.example']) {
      const res = await h.sso.exchange(fragmentCode(await signIn(h, p.id, person(), { returnTo: evil }))!, meta);
      expect(res.returnTo).toBe('/documents');
    }
  });

  it('a disabled provider cannot start a sign-in', async () => {
    const h = harness();
    const p = h.provider({ enabled: false });
    expect(await h.sso.start(p.id, '/documents')).toBe(`${WEB}/login?error=failed`);
    expect(await h.sso.start('not-a-uuid', '/documents')).toBe(`${WEB}/login?error=failed`);
  });

  it('an unreachable issuer sends the browser back with provider-error', async () => {
    const h = harness();
    const p = h.provider({ config: { issuer: 'http://127.0.0.1:1', clientId: 'x', scopes: [] } });
    expect(await h.sso.start(p.id, '/documents')).toBe(`${WEB}/login?error=provider-error`);
  });

  it('refuses a private issuer unless AUTH_SSO_ALLOW_PRIVATE_URLS', async () => {
    const h = harness(fakeConfig({ AUTH_SSO_ALLOW_PRIVATE_URLS: false }));
    const p = h.provider();
    expect(await h.sso.start(p.id, '/documents')).toBe(`${WEB}/login?error=provider-error`);
    expect(h.db.requests).toHaveLength(0);
  });
});

describe('discovery and login buttons', () => {
  it("discover answers on the domain alone and says whether a password is still allowed", async () => {
    const h = harness(fakeConfig({ AUTH_PASSWORD_LOGIN_ENABLED: false, AUTH_BREAK_GLASS_EMAILS: 'root@corp.example' }));
    const p = h.provider();
    h.provider({ enabled: false, name: 'Off' });
    expect(await h.sso.discover('Someone@Corp.Example')).toEqual({
      method: 'sso',
      providers: [{ id: p.id, name: 'Keycloak', kind: 'oidc', preset: 'keycloak' }],
      passwordAllowed: false,
    });
    expect((await h.sso.discover('root@corp.example')).passwordAllowed).toBe(true);
    expect(await h.sso.discover('x@other.example')).toMatchObject({ method: 'password', providers: [] });
  });

  it("login buttons are the workspace's own plus every platform-wide one", async () => {
    const h = harness();
    const own = h.provider({ name: 'A' });
    const wide = h.provider({ name: 'B', workspaceId: randomUUID(), platformWide: true });
    h.provider({ name: 'C', workspaceId: randomUUID() });
    h.provider({ name: 'D', showOnLogin: false });
    const res = await h.sso.loginProviders(WS);
    expect(res.providers.map((p) => p.id).sort()).toEqual([own.id, wide.id].sort());
    expect((await h.sso.loginProviders()).providers.map((p) => p.id)).toEqual([wide.id]);
  });
});

describe('password ceiling', () => {
  function passwordFlow(over: Record<string, unknown>) {
    const config = fakeConfig({ AUTH_SIGNUP_ENABLED: true, ...over });
    const audit = { record: vi.fn(async () => undefined) };
    const prisma = { user: { findUnique: vi.fn(async () => null) } };
    return new AuthFlowService(prisma as never, config as never, {} as never, {} as never, audit as never);
  }

  it('AUTH_PASSWORD_LOGIN_ENABLED=false refuses login and signup, and forgot-password mints nothing', async () => {
    const flow = passwordFlow({ AUTH_PASSWORD_LOGIN_ENABLED: false });
    await expect(flow.login('a@corp.example', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(flow.signup('a@corp.example', 'A', 'long enough')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(flow.forgotPassword('a@corp.example')).resolves.toEqual({ ok: true });
  });

  it('a break-glass address still reaches the password check', async () => {
    const flow = passwordFlow({ AUTH_PASSWORD_LOGIN_ENABLED: false, AUTH_BREAK_GLASS_EMAILS: ' Root@Corp.Example ,x@y.z' });
    // Past the ceiling, an unknown address is the usual uniform 401.
    await expect(flow.login('root@corp.example', 'x')).rejects.toMatchObject({ status: 401 });
  });
});

describe('claims', () => {
  it('Entra: pins the tenant, reads xms_edov as verification, and treats a groups overage as no groups', () => {
    const issuer = 'https://login.microsoftonline.com/0b6c7a3e-0000-4000-8000-000000000001/v2.0';
    const base = { sub: 's', email: 'a@corp.example', tid: '0b6c7a3e-0000-4000-8000-000000000001' };
    expect(identityFromClaims('entra', { ...base, tid: 'other' }, { issuer, groupsClaim: 'groups' })).toMatchObject({ ok: false, error: 'id-token-invalid' });
    const r = identityFromClaims('entra', { ...base, xms_edov: true, _claim_names: { groups: 'src1' } }, { issuer, groupsClaim: 'groups' });
    expect(r).toMatchObject({ ok: true, identity: { emailVerified: true, groups: [], notes: ['groups-overage'] } });
    expect(identityFromClaims('entra', base, { issuer, groupsClaim: 'groups' })).toMatchObject({ ok: true, identity: { emailVerified: false } });
  });

  it('Google: an account outside the hosted domain is refused even with an allowed address', async () => {
    const h = harness();
    const p = h.provider({ preset: 'generic' });
    // The generic preset does not read `hd`; a google-preset provider is checked by SsoLoginService.
    expect(fragmentCode(await signIn(h, p.id, person({ hd: undefined })))).toBeTruthy();

    const login = new SsoLoginService(h.prisma as never, h.audit as never);
    const google = { ...p, id: randomUUID(), preset: 'google' };
    const id = { subject: 'g1', email: 'bob@corp.example', emailVerified: true, displayName: null, groups: [], idpSessionId: null, notes: [] };
    expect(await login.resolve(google as never, { ...id, hostedDomain: null })).toMatchObject({ ok: false, error: 'domain-not-allowed' });
    expect(await login.resolve(google as never, { ...id, hostedDomain: 'corp.example' })).toMatchObject({ ok: true, created: true });
  });

  it('groups come from the configured claim, deduplicated and bounded', () => {
    const r = identityFromClaims('keycloak', { sub: 's', groups: ['/eng', '/eng', 'x'.repeat(300), 7] }, { issuer: 'i', groupsClaim: 'groups' });
    expect(r).toMatchObject({ ok: true, identity: { groups: ['/eng'] } });
  });
});

describe('helpers', () => {
  it('safeReturnTo keeps own paths only', () => {
    expect(safeReturnTo('/a?b=1', '/x')).toBe('/a?b=1');
    for (const bad of [undefined, '', 'https://e.x', '//e.x', '/\\e.x', 'a']) expect(safeReturnTo(bad, '/x')).toBe('/x');
  });

  it('normalizeDomain folds case, a leading @ and IDN to punycode; refuses what is no domain', () => {
    expect(normalizeDomain('@Corp.Example')).toBe('corp.example');
    expect(normalizeDomain('bücher.example')).toBe('xn--bcher-kva.example');
    for (const bad of ['localhost', 'a b.example', 'https://corp.example', '']) expect(normalizeDomain(bad)).toBeNull();
  });
});
