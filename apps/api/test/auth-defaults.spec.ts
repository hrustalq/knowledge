import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { AuthPolicyService } from '../src/auth/auth-policy.service.js';
import { toMeResponse } from '../src/auth/me-response.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { validateEnv } from '../src/config/env.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';

/**
 * #75 criterion 1: with every new env var at its default, existing auth
 * behaves exactly as before. The config is the real zod schema fed only the
 * vars that have no default — so a #75 default that changed the password or
 * key flow fails here, where a hand-built config would not notice.
 *
 * What is pinned, through the real AuthFlowService, SessionsService,
 * TokenAuthService and AuthPolicyService over an in-memory database:
 * - signup → login → forgot-password → reset, as a password session, with
 *   /me saying `authMethod: 'password'` and one mail per step;
 * - a `kn_` key resolves under AUTH_MODE=api-key, and AUTH_MODE=none is still
 *   the dev principal for any token;
 * - no workspace policy is enforced on either;
 * - a session row from before the migration (no auth_method, no provider_id)
 *   reads as a password session, and a member row with no `source` as manual.
 */

const WS = '11111111-1111-4111-8111-111111111111';

/** The real env schema: only the vars with no default are given. */
const env = (over: Record<string, unknown> = {}) =>
  validateEnv({
    DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_ACCESS_KEY: 'x', S3_SECRET_KEY: 'x',
    S3_BUCKET: 'x', ARCADE_URL: 'http://x', ARCADE_DB: 'x', ARCADE_USER: 'x', ARCADE_PASSWORD: 'x',
    ...over,
  });

type Row = Record<string, any>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function world(values: Record<string, unknown>) {
  const db = { users: [] as Row[], members: [] as Row[], sessions: [] as Row[], resets: [] as Row[], keys: [] as Row[] };
  const byWhere = (rows: Row[], where: Row) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: Row) => byWhere(db.users, where)),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: randomUUID(), isAdmin: false, disabledAt: null, emailVerifiedAt: null, avatarKey: null, avatarUpdatedAt: null, createdAt: new Date(), ...data };
        db.users.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(byWhere(db.users, where)!, data)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    workspace: { findUnique: vi.fn(async ({ where }: Row) => (where.id === WS ? { id: WS } : null)) },
    workspaceMember: {
      upsert: vi.fn(async ({ create }: Row) => {
        // Written the way the column's default fills it: no `source` given.
        const row = { trustedOperator: false, createdAt: new Date(), ...create };
        db.members.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: Row) => db.members.filter((m) => m.userId === where.userId)),
    },
    emailVerificationToken: { create: vi.fn(async () => ({})) },
    passwordResetToken: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: randomUUID(), usedAt: null, ...data };
        db.resets.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: Row) => byWhere(db.resets, where)),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(byWhere(db.resets, where)!, data)),
    },
    session: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: randomUUID(), createdAt: new Date(), revokedAt: null, lastSeenAt: null, ...data };
        db.sessions.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: Row) => {
        const row = byWhere(db.sessions, where);
        return row && { ...row, user: db.users.find((u) => u.id === row.userId) };
      }),
      updateMany: vi.fn(async ({ where }: Row) => {
        const hit = db.sessions.filter((s) => s.userId === where.userId && !s.revokedAt);
        for (const s of hit) s.revokedAt = new Date();
        return { count: hit.length };
      }),
    },
    apiKey: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const row = byWhere(db.keys, where);
        return row && { ...row, user: db.users.find((u) => u.id === row.userId) };
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    workspaceSettings: { findUnique: vi.fn(async () => null) },
    ssoDomain: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const config = { get: (k: string) => values[k] };
  const audit = { record: vi.fn(async () => undefined) };
  const mail = { enqueue: vi.fn(async () => undefined) };
  const sessions = new SessionsService(prisma as never, config as never);
  const policy = new AuthPolicyService(prisma as never, config as never, audit as never);
  const flow = new AuthFlowService(prisma as never, config as never, sessions, mail as never, audit as never, policy);
  const tokens = new TokenAuthService(config as never, prisma as never, sessions, {} as never);
  const templates = () => mail.enqueue.mock.calls.map((c) => (c as unknown as [{ template: string }])[0].template);
  return { db, prisma, flow, tokens, policy, mail, templates };
}

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';

describe.each([
  ['AUTH_MODE=none (every default)', env()],
  ['AUTH_MODE=api-key, nothing else set', env({ AUTH_MODE: 'api-key' })],
])('the password flow on the real defaults — %s', (_label, values) => {
  it('signs up and logs in as a password session, and /me says so', async () => {
    const { db, flow, templates } = world(values);
    const signup = await flow.signup(EMAIL, 'Ada', PASSWORD);
    expect(signup.me).toMatchObject({ mode: 'session', authMethod: 'password', email: EMAIL });
    // The default workspace and role, as before #75.
    expect(signup.me.memberships).toEqual([{ workspaceId: WS, role: 'viewer', trustedOperator: false, capabilities: [], source: 'manual' }]);
    expect(templates()).toEqual(['verify-email']);

    const login = await flow.login('Ada@Example.com', PASSWORD);
    expect(login.me.authMethod).toBe('password');
    expect(db.sessions.map((s) => [s.authMethod, s.providerId, s.idpSessionId])).toEqual([
      ['password', null, null],
      ['password', null, null],
    ]);
    await expect(flow.login(EMAIL, 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('mints one reset link, and the reset signs every session out', async () => {
    const { db, prisma, flow, templates } = world(values);
    await flow.signup(EMAIL, 'Ada', PASSWORD);
    const forgot = await flow.forgotPassword(EMAIL);
    expect(forgot).toMatchObject({ ok: true, debugToken: expect.stringMatching(/^kr_/) });
    expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
    expect(templates()).toEqual(['verify-email', 'password-reset']);

    await flow.resetPassword(forgot.debugToken!, 'a brand new secret');
    expect(db.sessions.every((s) => s.revokedAt)).toBe(true);
    await expect(flow.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(flow.login(EMAIL, 'a brand new secret')).resolves.toMatchObject({ me: { authMethod: 'password' } });
    expect(templates()).toEqual(['verify-email', 'password-reset', 'password-changed']);
  });

  it('enforces no workspace policy on a session or a key', async () => {
    const { flow, policy, prisma } = world(values);
    const { me } = await flow.signup(EMAIL, 'Ada', PASSWORD);
    const session = { ...DEV_PRINCIPAL, userId: me.userId, mode: 'session' as const, sessionId: 's1', authMethod: 'password' as const, sessionCreatedAt: new Date(0).toISOString() };
    const key = { ...DEV_PRINCIPAL, userId: me.userId, mode: 'api-key' as const, apiKey: { id: 'k1', scope: 'write' as const, workspaceId: null } };
    await expect(policy.enforce(session, WS)).resolves.toBeUndefined();
    await expect(policy.enforce(key, WS)).resolves.toBeUndefined();
    expect(prisma.ssoDomain.findUnique).not.toHaveBeenCalled();
  });
});

describe('tokens on the real defaults', () => {
  it('AUTH_MODE=none: any token, or none, is the dev principal', async () => {
    const { tokens } = world(env());
    await expect(tokens.resolve(undefined)).resolves.toBe(DEV_PRINCIPAL);
    await expect(tokens.resolve('kn_whatever')).resolves.toBe(DEV_PRINCIPAL);
  });

  it('AUTH_MODE=api-key: a kn_ key and a ks_ session resolve as before', async () => {
    const { db, flow, tokens } = world(env({ AUTH_MODE: 'api-key' }));
    const { token, me } = await flow.signup(EMAIL, 'Ada', PASSWORD);
    db.keys.push({ id: 'k1', userId: me.userId, keyHash: sha('kn_secret'), scope: 'write', workspaceId: null, projectIds: [], revokedAt: null, expiresAt: null });

    expect(await tokens.resolve('kn_secret')).toMatchObject({ mode: 'api-key', userId: me.userId, apiKey: { id: 'k1', scope: 'write' } });
    await expect(tokens.resolve('kn_unknown')).rejects.toBeInstanceOf(UnauthorizedException);
    const session = await tokens.resolve(token);
    expect(session).toMatchObject({ mode: 'session', authMethod: 'password' });
    expect('providerId' in session).toBe(false);
  });
});

describe('rows from before the #75 migration', () => {
  it('a session with no auth_method or provider_id reads as a password session', async () => {
    const { db, tokens } = world(env({ AUTH_MODE: 'api-key' }));
    db.users.push({ id: 'u1', email: EMAIL, displayName: 'Ada', isAdmin: false, locale: 'en', disabledAt: null, emailVerifiedAt: new Date(), avatarKey: null, avatarUpdatedAt: null });
    // The pre-migration shape: only the columns sessions had then.
    db.sessions.push({ id: 's-old', userId: 'u1', tokenHash: sha('ks_legacy'), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null, createdAt: new Date() });

    const principal = await tokens.resolve('ks_legacy');
    expect(principal).toMatchObject({ mode: 'session', sessionId: 's-old', authMethod: 'password' });
    expect('providerId' in principal).toBe(false);
    expect(toMeResponse(principal, [], false).authMethod).toBe('password');
  });

  it('a member with no source reads, and edits, as manual', async () => {
    const member: Row = { workspaceId: WS, userId: 'u1', role: 'editor', trustedOperator: false, createdAt: new Date() };
    const user = { id: 'u1', email: EMAIL, displayName: 'Ada', disabledAt: null, avatarKey: null, avatarUpdatedAt: null };
    const prisma = {
      workspaceMember: {
        findUnique: vi.fn(async () => member),
        findMany: vi.fn(async () => [{ ...member, user }]),
        update: vi.fn(async ({ data }: Row) => Object.assign(member, data)),
      },
      // setRoleGuarded's one statement: no last-admin question for an editor.
      $executeRaw: vi.fn(async () => {
        member.role = 'viewer';
        return 1;
      }),
    };
    const workspaces = new WorkspacesService(prisma as never);
    expect((await workspaces.listMembers(WS)).members[0].source).toBe('manual');
    const after = await workspaces.updateMember(WS, 'u1', { role: 'viewer' });
    expect(after.members[0]).toMatchObject({ role: 'viewer', source: 'manual' });
  });

  it('the migration fills both columns with those defaults', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../prisma/migrations/20261109100000_enterprise_auth/migration.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/ALTER TABLE "sessions" ADD COLUMN\s+"auth_method" TEXT NOT NULL DEFAULT 'password'/);
    expect(sql).toMatch(/ALTER TABLE "workspace_members" ADD COLUMN\s+"source" TEXT NOT NULL DEFAULT 'manual'/);
  });
});
