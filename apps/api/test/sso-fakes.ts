import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { OidcService } from '../src/auth/sso/oidc.service.js';
import { SamlService } from '../src/auth/sso/saml.service.js';
import { LdapService } from '../src/auth/sso/ldap.service.js';
import { SsoFlowService } from '../src/auth/sso/sso-flow.service.js';
import { SsoLoginService } from '../src/auth/sso/sso-login.service.js';
import { RoleSyncService } from '../src/auth/sso/role-sync.service.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * The SSO sign-in services over an in-memory Prisma (#75), shared by the OIDC
 * and SAML specs: everything but the database is real.
 */

export const WS = '22222222-2222-4222-8222-222222222222';
export const API = 'http://api.test';
export const WEB = 'http://web.test';

export function fakeConfig(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    AUTH_SSO_ALLOW_PRIVATE_URLS: true,
    API_PUBLIC_URL: API,
    WEB_BASE_URL: WEB,
    AUTH_SSO_STATE_TTL_SEC: 600,
    SETTINGS_ENCRYPTION_KEY: '',
    AUTH_PASSWORD_LOGIN_ENABLED: true,
    AUTH_BREAK_GLASS_EMAILS: '',
    AUTH_SESSION_TTL_HOURS: 720,
    AUTH_LDAP_ENABLED: false,
    AUTH_LDAP_ALLOW_INSECURE: false,
    NODE_ENV: 'test',
    ...over,
  };
  return { get: (k: string) => values[k] };
}

export type Row = Record<string, any>;

/** Just enough of Prisma for the SSO tables, in memory, with the unique indexes that matter. */
export function fakePrisma() {
  const db = {
    providers: [] as Row[],
    requests: [] as Row[],
    identities: [] as Row[],
    users: [] as Row[],
    members: [] as Row[],
    sessions: [] as Row[],
  };
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'kind' && v && typeof v === 'object' && 'in' in v) return (v.in as string[]).includes(row.kind);
      if (k === 'allowedDomains' && v && typeof v === 'object') return row.allowedDomains.includes(v.has);
      if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
      return row[k] === v;
    });
  const prisma = {
    idpGroupMapping: { findMany: vi.fn(async () => []) },
    identityProvider: {
      findFirst: vi.fn(async ({ where }: Row) => db.providers.find((p) => match(p, where)) ?? null),
      findMany: vi.fn(async ({ where }: Row) => db.providers.filter((p) => match(p, where))),
    },
    ssoAuthRequest: {
      create: vi.fn(async ({ data }: Row) => {
        if (db.requests.some((r) => r.stateHash === data.stateHash)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        const row = { id: randomUUID(), consumedAt: null, exchangeCodeHash: null, userId: null, idpSessionId: null, createdAt: new Date(), ...data };
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
    session: {
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = db.sessions.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
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

/** The SSO services over the in-memory tables; `defaults` are each test provider's columns. */
export function ssoHarness(config = fakeConfig(), defaults: Row = {}) {
  const { prisma, db } = fakePrisma();
  const audit = { record: vi.fn(async () => undefined) };
  const sessions = {
    create: vi.fn(async (_userId: string, _meta: Row) => ({
      token: `ks_${randomUUID()}`,
      session: { id: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) },
    })),
  };
  const oidc = new OidcService(config as never);
  const login = new SsoLoginService(prisma as never, audit as never, new RoleSyncService(prisma as never, audit as never));
  const flow = new AuthFlowService(prisma as never, config as never, sessions as never, {} as never, audit as never, noAuthPolicy);
  const saml = new SamlService(config as never);
  const ldap = new LdapService(config as never);
  const sso = new SsoFlowService(prisma as never, config as never, oidc, login, flow, audit as never, noAuthPolicy, saml, ldap);

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
      secretCipher: null,
      jitEnabled: true,
      defaultRole: 'editor',
      allowedDomains: ['corp.example'],
      groupsClaim: null,
      groupSyncMode: 'additive',
      sessionTtlHours: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...defaults,
      ...over,
    };
    db.providers.push(row);
    return row;
  };
  const failures = () => (audit.record.mock.calls as unknown as Row[][]).map((c) => c[0]).filter((e) => e.action === 'auth.login_failed');
  return { sso, oidc, saml, ldap, prisma, db, audit, sessions, provider, failures };
}

