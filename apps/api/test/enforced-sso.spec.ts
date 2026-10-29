import { afterEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { Access } from '../src/auth/access.decorator.js';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { FeaturesService } from '../src/auth/features.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { AuthPolicyService, policyFailure } from '../src/auth/auth-policy.service.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { hashPassword } from '../src/auth/password.js';
import type { Principal } from '../src/auth/principal.js';
import { DOMAIN_RECHECK_MS, SsoDomainsService } from '../src/auth/sso/sso-domains.service.js';
import { proveDomain } from '../src/auth/sso/sso-dns.js';
import { SsoMaintenanceSweeper } from '../src/auth/sso/sso-maintenance.sweeper.js';
import { LiveGateway } from '../src/events/live.gateway.js';
import { ENFORCING_PROVIDER, enforcingPolicy, policyByWorkspace } from './auth-policy-fakes.js';

/**
 * Enforced SSO (#75 phase 4). What is pinned:
 * - the matrix: a password session, another workspace's IdP, an oidc session
 *   from this workspace's IdP, a key with keys allowed or blocked, unattended
 *   work, a platform admin (passes, audited once), and the session age cap;
 * - the instance ceiling: AUTH_SSO_ENABLED off means no enforcement, whatever the row says;
 * - REST (AclGuard), MCP (requireRole from a tool) and a WS subscribe all meet it;
 * - an enforced domain refuses a password at login, signup and reset, lets
 *   break-glass through, and lets an admin through only with the right
 *   password — the refusal never says which addresses are admins;
 * - the policy PUT refuses a policy its own caller would fail, or one nothing can satisfy;
 * - a domain is proven by DNS (or a platform admin), enforced only when
 *   proven, held against other workspaces, and given up after a week pending.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_PROVIDER = 'bbbbbbbb-0000-4000-8000-000000000002';

const base: Principal = {
  userId: '33333333-3333-4333-8333-333333333333',
  email: 'ada@corp.example',
  displayName: 'Ada',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};
const passwordSession = (extra: Partial<Principal> = {}): Principal => ({
  ...base,
  sessionId: 's-pw',
  authMethod: 'password',
  sessionCreatedAt: new Date().toISOString(),
  ...extra,
});
const ssoSession = (providerId = ENFORCING_PROVIDER.id, extra: Partial<Principal> = {}): Principal =>
  passwordSession({ sessionId: 's-sso', authMethod: 'oidc', providerId, ...extra });
const key = (extra: Partial<Principal> = {}): Principal => ({
  ...base,
  mode: 'api-key',
  apiKey: { id: 'k1', scope: 'write', workspaceId: null },
  ...extra,
});
/** What `AccessService.principalFor` hands an agent run: neither a session nor a key. */
const unattended: Principal = { ...base, mode: 'api-key' };

const enforced = { ssoEnforced: true, allowApiKeys: true, allowPasswordForAdmins: false, sessionMaxAgeHours: null, providers: [ENFORCING_PROVIDER] };

describe('policyFailure — the enforcement matrix', () => {
  it.each([
    ['a password session', passwordSession(), 'password-session'],
    ["another workspace's IdP", ssoSession(OTHER_PROVIDER), 'foreign-provider'],
    ["an oidc session from this workspace's IdP", ssoSession(), null],
    ['a key, keys allowed', key(), null],
    ['unattended work', unattended, null],
  ])('%s → %s', (_label, principal, failure) => {
    expect(policyFailure(principal, enforced)).toBe(failure);
  });

  it('blocks a key only when the workspace says so', () => {
    expect(policyFailure(key(), { ...enforced, allowApiKeys: false })).toBe('api-key');
    expect(policyFailure(key(), { ...enforced, ssoEnforced: false, allowApiKeys: false })).toBeNull();
  });

  it('caps a session’s age with or without enforced SSO, and never a key’s', () => {
    const old = passwordSession({ sessionCreatedAt: new Date(Date.now() - 9 * 3_600_000).toISOString() });
    const capped = { ...enforced, ssoEnforced: false, sessionMaxAgeHours: 8 };
    expect(policyFailure(old, capped)).toBe('session-too-old');
    expect(policyFailure(passwordSession(), capped)).toBeNull();
    expect(policyFailure(key(), capped)).toBeNull();
  });
});

function accessWith(policy: AuthPolicyService, role: string | null = 'viewer') {
  const prisma = {
    workspaceMember: { findUnique: vi.fn(async () => (role ? { role, trustedOperator: false } : null)) },
    workspace: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
  };
  return new AccessService(prisma as never, policy);
}

describe('AccessService.requireRole under enforced SSO', () => {
  it('refuses a password session with the providers to sign in through', async () => {
    const { policy } = enforcingPolicy();
    const err = await accessWith(policy).requireRole(passwordSession(), WS, 'viewer').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ reason: 'ssoRequired', workspaceId: WS, providers: [ENFORCING_PROVIDER] });
  });

  it('admits the right IdP, keys unless blocked, and unattended work', async () => {
    const { policy } = enforcingPolicy();
    await expect(accessWith(policy).requireRole(ssoSession(), WS, 'viewer')).resolves.toBeUndefined();
    await expect(accessWith(policy).requireRole(key(), WS, 'viewer')).resolves.toBeUndefined();
    await expect(accessWith(policy).requireRole(unattended, WS, 'viewer')).resolves.toBeUndefined();
    const blocked = enforcingPolicy({ allowApiKeys: false }).policy;
    await expect(accessWith(blocked).requireRole(key(), WS, 'viewer')).rejects.toThrow(/apiKeysBlocked/);
  });

  it('still narrows a key first: a pinned key is refused for its pin, not for SSO', async () => {
    const { policy } = enforcingPolicy({ allowApiKeys: false });
    const pinned = key({ apiKey: { id: 'k1', scope: 'write', workspaceId: OTHER_PROVIDER } });
    await expect(accessWith(policy).requireRole(pinned, WS, 'viewer')).rejects.toThrow(/apiKeyWorkspace/);
  });

  it('lets a platform admin through as break-glass, audited once per session and workspace', async () => {
    const { policy, audit } = enforcingPolicy();
    const admin = passwordSession({ isAdmin: true });
    await accessWith(policy, null).requireRole(admin, WS, 'admin');
    await accessWith(policy, null).requireRole(admin, WS, 'admin');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.sso_bypassed', workspaceId: WS, params: expect.objectContaining({ reason: 'password-session' }) }),
    );
  });

  it('enforces nothing under the instance ceiling (AUTH_SSO_ENABLED off), whatever the row says', async () => {
    const { policy } = enforcingPolicy({}, { AUTH_SSO_ENABLED: false });
    await expect(accessWith(policy).requireRole(passwordSession(), WS, 'viewer')).resolves.toBeUndefined();
  });

  it('reads the policy once per 30 s, and again after a write invalidates it', async () => {
    const { policy, prisma } = enforcingPolicy();
    const access = accessWith(policy);
    await access.requireRole(ssoSession(), WS, 'viewer');
    await access.requireRole(ssoSession(), WS, 'viewer');
    expect(prisma.workspaceSettings.findUnique).toHaveBeenCalledTimes(1);
    policy.invalidate(WS);
    await access.requireRole(ssoSession(), WS, 'viewer');
    expect(prisma.workspaceSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('asks a session older than the cap to sign in again', async () => {
    const { policy } = enforcingPolicy({ ssoEnforced: null, sessionMaxAgeHours: 1 });
    const old = passwordSession({ sessionCreatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    const err = await accessWith(policy).requireRole(old, WS, 'viewer').catch((e: unknown) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ reason: 'reauthRequired', providers: [] });
  });
});

describe('every surface meets the same check', () => {
  it('REST: AclGuard on an @Access route', async () => {
    const { policy } = enforcingPolicy();
    const reflector = { getAllAndOverride: () => false, get: () => ({ role: 'viewer', source: 'query', operator: false }) };
    const guard = new AclGuard(reflector as never, accessWith(policy), {} as never);
    const ctx = (principal: Principal) => ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ principal, method: 'GET', params: {}, query: { workspaceId: WS }, body: {} }) }),
    });
    await expect(guard.canActivate(ctx(passwordSession()) as never)).rejects.toThrow(/ssoRequired/);
    await expect(guard.canActivate(ctx(ssoSession()) as never)).resolves.toBe(true);
  });

  it('WS: a subscribe from a password session gets a 403 frame and no subscription', async () => {
    const { policy } = enforcingPolicy();
    const config = { get: (k: string) => ({ LIVE_WS_ENABLED: true, LIVE_TRACKED_EVENTS: '', LIVE_WS_MAX_SUBSCRIPTIONS: 10 })[k] };
    const subscribe = async (principal: Principal) => {
      const tokenAuth = { resolve: vi.fn(async () => principal), blocksUnverified: () => false };
      const gw = new LiveGateway(config as never, tokenAuth as never, accessWith(policy), {} as never, {} as never);
      const socket = { on: vi.fn(), close: vi.fn(), send: vi.fn() };
      await gw.handleConnection(socket as never, { url: '/v1/events/ws?token=ks_x', headers: {} } as never);
      await (gw as unknown as { handleMessage(s: unknown, raw: string): Promise<void> }).handleMessage(
        socket,
        JSON.stringify({ type: 'subscribe', workspaceId: WS }),
      );
      return socket.send.mock.calls.map(([frame]) => JSON.parse(frame as string) as { type: string; error?: { statusCode: number } });
    };
    expect(await subscribe(passwordSession())).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({ statusCode: 403 }) })]);
    expect((await subscribe(ssoSession())).map((f) => f.type)).toEqual(['subscribed']);
  });
});

// ------------------------------------------------------------ real transports (#300)

const WS_B = '22222222-2222-4222-8222-222222222222';

@Controller('v1')
class ProbeController {
  @Get('probe')
  @Access('viewer', 'query')
  probe() {
    return { ok: true };
  }
}

describe('enforced SSO through the real transports (#75 criterion 11)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const principals: Record<string, Principal> = {
    ks_password: passwordSession(),
    ks_sso: ssoSession(),
    ks_admin: passwordSession({ sessionId: 's-admin', isAdmin: true }),
    kn_key: key(),
  };

  /** AuthGuard → AclGuard → the handler, with ApiExceptionFilter writing the body a client reads. */
  async function rest(policy: AuthPolicyService, role: string | null = 'viewer') {
    const tokenAuth = {
      blocksUnverified: () => false,
      resolve: vi.fn(async (token: string | undefined) => {
        const principal = token ? principals[token] : undefined;
        if (!principal) throw new UnauthorizedException('no');
        return principal;
      }),
    };
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: TokenAuthService, useValue: tokenAuth },
        { provide: AccessService, useValue: accessWith(policy, role) },
        { provide: PermissionService, useValue: {} },
        // The probe route belongs to no section (#604), so the toggles are never read.
        { provide: FeaturesService, useValue: {} },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: AclGuard },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    const http = request(app.getHttpServer());
    return (token: string, workspaceId = WS) => http.get('/v1/probe').query({ workspaceId }).set('Authorization', `Bearer ${token}`);
  }

  it('REST: the 403 body carries reason, workspaceId and providers in details; the right IdP gets a 200', async () => {
    const get = await rest(enforcingPolicy().policy);
    const res = await get('ks_password');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/ssoRequired/),
      details: { reason: 'ssoRequired', workspaceId: WS, providers: [ENFORCING_PROVIDER] },
    });
    expect((await get('ks_sso')).status).toBe(200);
  });

  it('allowApiKeys=false blocks a key in that workspace only', async () => {
    const get = await rest(policyByWorkspace({ [WS]: { allowApiKeys: false } }).policy);
    const blocked = await get('kn_key', WS);
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toEqual({ reason: 'apiKeysBlocked', workspaceId: WS });
    expect((await get('kn_key', WS_B)).status).toBe(200);
    // And nothing else of WS's policy reaches WS_B either.
    expect((await get('ks_password', WS_B)).status).toBe(200);
  });

  it('REST: a platform admin on a password session passes, and one auth.sso_bypassed row is written', async () => {
    const { policy, audit } = enforcingPolicy();
    const get = await rest(policy, null);
    expect((await get('ks_admin')).status).toBe(200);
    expect((await get('ks_admin')).status).toBe(200);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.sso_bypassed', workspaceId: WS, params: expect.objectContaining({ reason: 'password-session', sessionId: 's-admin' }) }),
    );
  });

  it('WS: a platform admin on a password session subscribes, and one auth.sso_bypassed row is written', async () => {
    const { policy, audit } = enforcingPolicy();
    const config = { get: (k: string) => ({ LIVE_WS_ENABLED: true, LIVE_TRACKED_EVENTS: '', LIVE_WS_MAX_SUBSCRIPTIONS: 10 })[k] };
    const tokenAuth = { resolve: vi.fn(async () => principals.ks_admin), blocksUnverified: () => false };
    const gw = new LiveGateway(config as never, tokenAuth as never, accessWith(policy, null), {} as never, {} as never);
    const socket = { on: vi.fn(), close: vi.fn(), send: vi.fn() };
    await gw.handleConnection(socket as never, { url: '/v1/events/ws?token=ks_admin', headers: {} } as never);
    const handle = (gw as unknown as { handleMessage(s: unknown, raw: string): Promise<void> }).handleMessage.bind(gw);
    await handle(socket, JSON.stringify({ type: 'subscribe', workspaceId: WS }));
    expect(socket.send.mock.calls.map(([frame]) => (JSON.parse(frame as string) as { type: string }).type)).toEqual(['subscribed']);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.sso_bypassed', workspaceId: WS }));
  });
});

// ------------------------------------------------------------ enforced domains

async function loginWorld(opts: { admin?: boolean; allowPasswordForAdmins?: boolean; breakGlass?: string; enforced?: boolean } = {}) {
  const user = {
    id: 'u1', email: 'ada@corp.example', displayName: 'Ada', isAdmin: opts.admin ?? false, locale: 'en', disabledAt: null,
    emailVerifiedAt: new Date(), avatarKey: null, avatarUpdatedAt: null, passwordHash: await hashPassword('correct horse'),
  };
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { email: string } }) => (where.email === user.email ? user : null)) },
    workspaceMember: { findMany: vi.fn(async () => []) },
    ssoDomain: {
      findUnique: vi.fn(async () => ({ domain: 'corp.example', workspaceId: WS, providerId: ENFORCING_PROVIDER.id, enforced: opts.enforced ?? true, verifiedAt: new Date() })),
    },
    workspaceSettings: { findUnique: vi.fn(async () => ({ allowPasswordForAdmins: opts.allowPasswordForAdmins ?? null })) },
    passwordResetToken: { create: vi.fn(async () => ({})) },
  };
  const env: Record<string, unknown> = {
    NODE_ENV: 'test', AUTH_MODE: 'api-key', AUTH_SSO_ENABLED: true, AUTH_SIGNUP_ENABLED: true, AUTH_PASSWORD_LOGIN_ENABLED: true,
    AUTH_BREAK_GLASS_EMAILS: opts.breakGlass ?? '', AUTH_SESSION_TTL_HOURS: 720,
  };
  const config = { get: (k: string) => env[k] };
  const audit = { record: vi.fn(async () => undefined) };
  const sessions = { create: vi.fn(async () => ({ token: 'ks_t', session: { id: 's1', expiresAt: new Date() } })) };
  const mail = { enqueue: vi.fn(async () => undefined) };
  const policy = new AuthPolicyService(prisma as never, config as never, audit as never);
  const flow = new AuthFlowService(prisma as never, config as never, sessions as never, mail as never, audit as never, policy);
  return { flow, audit, sessions, mail, prisma };
}

const refusalOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ForbiddenException);
  return (err as ForbiddenException).getResponse();
};

describe('a verified, enforced domain refuses passwords', () => {
  it('at login, before the password is even looked at, naming the provider to use', async () => {
    const { flow, sessions } = await loginWorld();
    expect(await refusalOf(flow.login('Ada@Corp.Example', 'correct horse'))).toMatchObject({
      reason: 'ssoRequiredForDomain',
      domain: 'corp.example',
      providerId: ENFORCING_PROVIDER.id,
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('at signup, and mints no reset link', async () => {
    const { flow, mail, prisma } = await loginWorld();
    expect(await refusalOf(flow.signup('new@corp.example', 'New', 'correct horse battery'))).toMatchObject({
      reason: 'ssoRequiredForDomain',
      domain: 'corp.example',
      providerId: ENFORCING_PROVIDER.id,
    });
    expect(await flow.forgotPassword('ada@corp.example')).toEqual({ ok: true });
    // Refused before the token is minted, not just before the mail is queued.
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(mail.enqueue).not.toHaveBeenCalled();
  });

  it('lets a break-glass address through, and audits the sign-in as one', async () => {
    const { flow, audit } = await loginWorld({ breakGlass: 'ada@corp.example' });
    await expect(flow.login('ada@corp.example', 'correct horse')).resolves.toMatchObject({ token: 'ks_t' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', workspaceId: WS, params: expect.objectContaining({ breakGlass: true }) }),
    );
  });

  it('lets a platform admin through only with the exception on and the right password', async () => {
    expect(await refusalOf((await loginWorld({ admin: true })).flow.login('ada@corp.example', 'correct horse'))).toMatchObject({
      reason: 'ssoRequiredForDomain',
    });
    const on = await loginWorld({ admin: true, allowPasswordForAdmins: true });
    await expect(on.flow.login('ada@corp.example', 'correct horse')).resolves.toMatchObject({ token: 'ks_t' });
  });

  it('answers a wrong admin password, an unknown address and a non-admin alike — nobody learns who is an admin', async () => {
    const admin = await loginWorld({ admin: true, allowPasswordForAdmins: true });
    const member = await loginWorld({ allowPasswordForAdmins: true });
    const bodies = [
      await refusalOf(admin.flow.login('ada@corp.example', 'wrong')),
      await refusalOf(member.flow.login('ada@corp.example', 'correct horse')),
      await refusalOf(member.flow.login('nobody@corp.example', 'whatever')),
    ];
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('refuses nothing while the domain is claimed but not enforced', async () => {
    const { flow } = await loginWorld({ enforced: false });
    await expect(flow.login('ada@corp.example', 'correct horse')).resolves.toMatchObject({ token: 'ks_t' });
  });
});

// ------------------------------------------------------------ the policy PUT

function putWorld(providers = [ENFORCING_PROVIDER], env: Record<string, unknown> = {}) {
  const prisma = {
    workspaceSettings: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    identityProvider: { findMany: vi.fn(async () => providers) },
  };
  const config = { get: (k: string) => ({ AUTH_SSO_ENABLED: true, AUTH_MODE: 'api-key', AUTH_SESSION_TTL_HOURS: 720, ...env })[k] };
  const audit = { record: vi.fn(async () => undefined) };
  return { policy: new AuthPolicyService(prisma as never, config as never, audit as never), prisma, audit };
}
const ask = (over: Record<string, unknown>) => ({ ssoEnforced: null, allowApiKeys: null, allowPasswordForAdmins: null, sessionMaxAgeHours: null, ...over });

describe('PUT /v1/workspaces/:id/auth-policy', () => {
  it('refuses to enforce SSO from the password session saving it', async () => {
    const { policy, prisma } = putWorld();
    const err = await policy.put(WS, ask({ ssoEnforced: true }), passwordSession()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ failure: 'password-session' });
    expect(prisma.workspaceSettings.upsert).not.toHaveBeenCalled();
  });

  it('saves it from an SSO session, audits before and after, and shows asked vs applied', async () => {
    const { policy, audit } = putWorld();
    const view = await policy.put(WS, ask({ ssoEnforced: true, sessionMaxAgeHours: 1000 }), ssoSession());
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sso.policy_updated', workspaceId: WS }));
    expect(view.ceilings).toEqual({ ssoEnabled: true, sessionTtlHours: 720 });
  });

  it('refuses a policy nothing could satisfy: no provider, or SSO off on the instance', async () => {
    await expect(putWorld([]).policy.put(WS, ask({ ssoEnforced: true }), ssoSession())).rejects.toThrow(/policyNoProvider/);
    await expect(putWorld([ENFORCING_PROVIDER], { AUTH_SSO_ENABLED: false }).policy.put(WS, ask({ ssoEnforced: true }), ssoSession())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('clamps an age cap no shorter than the instance session lifetime to none', () => {
    const { policy } = putWorld();
    expect(policy.apply(ask({ sessionMaxAgeHours: 720 })).sessionMaxAgeHours).toBeNull();
    expect(policy.apply(ask({ sessionMaxAgeHours: 8 })).sessionMaxAgeHours).toBe(8);
  });
});

// ------------------------------------------------------------ domains

type Row = Record<string, any>;

function domainWorld(opts: { txt?: string[] | Error; domains?: Row[]; admin?: boolean } = {}) {
  const db = { domains: (opts.domains ?? []).map((d) => ({ providerId: null, verifiedAt: null, enforced: false, createdAt: new Date(), ...d })) };
  const withProvider = (d: Row | undefined) => (d ? { ...d, provider: d.providerId ? { id: d.providerId, name: 'Corp SSO' } : null } : null);
  const prisma = {
    ssoDomain: {
      findMany: vi.fn(async ({ where }: Row) =>
        db.domains
          .filter((d) => (where.workspaceId ? d.workspaceId === where.workspaceId : true))
          .filter((d) => (where.verifiedAt === null ? d.verifiedAt === null : true))
          .map(withProvider),
      ),
      findUnique: vi.fn(async ({ where }: Row) => withProvider(db.domains.find((d) => d.domain === where.domain))),
      findFirst: vi.fn(async ({ where }: Row) => withProvider(db.domains.find((d) => d.domain === where.domain && d.workspaceId === where.workspaceId))),
      create: vi.fn(async ({ data }: Row) => {
        if (db.domains.some((d) => d.domain === data.domain)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        const row = { verifiedAt: null, enforced: false, createdAt: new Date(), ...data };
        db.domains.push(row);
        return withProvider(row);
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const before = db.domains.length;
        db.domains = db.domains.filter((d) => !(d.domain === where.domain && d.verifiedAt === null && d.createdAt < where.createdAt.lt));
        return { count: before - db.domains.length };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = db.domains.find((d) => d.domain === where.domain && d.workspaceId === where.workspaceId && d.verifiedAt === null);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: Row) => withProvider(Object.assign(db.domains.find((d) => d.domain === where.domain)!, data))),
      delete: vi.fn(async () => ({})),
    },
    identityProvider: {
      findMany: vi.fn(async () => [ENFORCING_PROVIDER]),
      findFirst: vi.fn(async ({ where }: Row) => (where.id === ENFORCING_PROVIDER.id ? { id: ENFORCING_PROVIDER.id } : null)),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const policy = { providersFor: vi.fn(async () => [ENFORCING_PROVIDER]) };
  const lookup = vi.fn(async () => {
    if (opts.txt instanceof Error) throw opts.txt;
    return opts.txt ?? [];
  });
  const service = new SsoDomainsService(prisma as never, audit as never, policy as never, lookup);
  const admin = { ...base, isAdmin: opts.admin ?? false };
  return { service, db, audit, lookup, admin };
}

describe('SSO domains', () => {
  it('claims a domain in one lower-case punycode form, with a TXT record to publish', async () => {
    const { service, audit } = domainWorld();
    const view = await service.claim(WS, { domain: '@Corp.Example.' }, base);
    expect(view).toMatchObject({ domain: 'corp.example', recordName: '_knowledge-challenge.corp.example', verifiedAt: null, enforced: false });
    expect(view.verificationToken).toMatch(/^knowledge-verification=/);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sso.domain_claimed', target: 'corp.example' }));
  });

  it("is held against another workspace while pending — and given up once its week is out", async () => {
    const fresh = domainWorld({ domains: [{ domain: 'corp.example', workspaceId: 'ws-squatter', verificationToken: 't' }] });
    await expect(fresh.service.claim(WS, { domain: 'corp.example' }, base)).rejects.toThrow(/domainTaken/);
    const stale = domainWorld({
      domains: [{ domain: 'corp.example', workspaceId: 'ws-squatter', verificationToken: 't', createdAt: new Date(Date.now() - DOMAIN_RECHECK_MS - 60_000) }],
    });
    await expect(stale.service.claim(WS, { domain: 'corp.example' }, base)).resolves.toMatchObject({ workspaceId: WS });
    const verified = domainWorld({ domains: [{ domain: 'corp.example', workspaceId: 'ws-owner', verificationToken: 't', verifiedAt: new Date(0), createdAt: new Date(0) }] });
    await expect(verified.service.claim(WS, { domain: 'corp.example' }, base)).rejects.toThrow(/domainTaken/);
  });

  it('is proven by its TXT record; a wrong record and a missing one say which', async () => {
    const token = 'knowledge-verification=abc';
    const domains = [{ domain: 'corp.example', workspaceId: WS, verificationToken: token }];
    const ok = domainWorld({ domains, txt: ['v=spf1 -all', token] });
    expect((await ok.service.verify(WS, 'corp.example', base)).domain.verifiedAt).not.toBeNull();
    expect(ok.lookup).toHaveBeenCalledWith('_knowledge-challenge.corp.example');
    expect(ok.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sso.domain_verified', params: { domain: 'corp.example', method: 'dns' } }));
    expect((await domainWorld({ domains, txt: ['other'] }).service.verify(WS, 'corp.example', base)).error).toBe('mismatch');
    const missing = Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    expect((await domainWorld({ domains, txt: missing }).service.verify(WS, 'corp.example', base)).error).toBe('no-record');
  });

  it('may be verified by hand by a platform admin only', async () => {
    const domains = [{ domain: 'corp.example', workspaceId: WS, verificationToken: 't' }];
    await expect(domainWorld({ domains }).service.verify(WS, 'corp.example', base, true)).rejects.toThrow(/manualVerifyAdminOnly/);
    const w = domainWorld({ domains, admin: true });
    expect((await w.service.verify(WS, 'corp.example', w.admin, true)).domain.verifiedAt).not.toBeNull();
    expect(w.lookup).not.toHaveBeenCalled();
  });

  it('is enforced only once verified, and another workspace’s domain is a 404', async () => {
    const pending = domainWorld({ domains: [{ domain: 'corp.example', workspaceId: WS, verificationToken: 't' }] });
    await expect(pending.service.update(WS, 'corp.example', { enforced: true }, base)).rejects.toThrow(/domainNotVerified/);
    await expect(pending.service.update('ws-other', 'corp.example', { enforced: true }, base)).rejects.toThrow(/domainNotFound/);
    const proven = domainWorld({ domains: [{ domain: 'corp.example', workspaceId: WS, verificationToken: 't', verifiedAt: new Date() }] });
    await expect(proven.service.update(WS, 'corp.example', { enforced: true }, base)).resolves.toMatchObject({ enforced: true });
    expect(proven.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sso.domain_enforced' }));
  });

  it('is rechecked by the sweeper while pending, which also purges expired rows', async () => {
    const token = 'knowledge-verification=abc';
    const w = domainWorld({ domains: [{ domain: 'corp.example', workspaceId: WS, verificationToken: token }], txt: [token] });
    const prisma = {
      ssoAuthRequest: { deleteMany: vi.fn(async () => ({ count: 2 })) },
      session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    const config = { get: (k: string) => ({ AUTH_SSO_ENABLED: true, AUTH_MODE: 'api-key' })[k] };
    const sweeper = new SsoMaintenanceSweeper(config as never, prisma as never, w.service);
    await sweeper.sweep();
    expect(w.db.domains[0].verifiedAt).toBeInstanceOf(Date);
    expect(prisma.ssoAuthRequest.deleteMany).toHaveBeenCalled();
    expect(w.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sso.domain_verified', actor: 'sso-maintenance' }));
  });

  it('treats a resolver failure as neither proof nor refusal', async () => {
    const timeout = Object.assign(new Error('t'), { code: 'ETIMEOUT' });
    expect(await proveDomain(async () => Promise.reject(timeout), 'corp.example', 'x')).toBe('lookup-failed');
  });
});
