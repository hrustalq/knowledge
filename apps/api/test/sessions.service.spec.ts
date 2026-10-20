import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { SessionsService } from '../src/auth/sessions.service.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { toMeResponse } from '../src/auth/me-response.js';

/**
 * Session metadata (#75 phase 1). What is pinned:
 * - a session records how it was opened, and a caller that passes nothing
 *   still gets today's session: a password login with no metadata;
 * - last_seen_at is one guarded statement that writes at most once a minute;
 * - a person can revoke only their own sessions, and a foreign id is unknown;
 * - the resolved principal carries the method, and /me shows it for a session only.
 */

const config = { get: (k: string) => ({ AUTH_SESSION_TTL_HOURS: 720, AUTH_MODE: 'api-key' })[k] };

function fakePrisma() {
  return {
    session: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 's1', createdAt: new Date(), ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(async () => null as unknown),
    },
    identityProvider: {
      findMany: vi.fn(async () => [{ id: 'p1', name: 'Corp SSO' }]),
    },
  };
}

describe('SessionsService', () => {
  it('stores how a session was opened, defaulting to a bare password session', async () => {
    const prisma = fakePrisma();
    const sessions = new SessionsService(prisma as never, config as never);

    await sessions.create('u1');
    expect(prisma.session.create.mock.calls[0][0].data).toMatchObject({
      userId: 'u1',
      authMethod: 'password',
      providerId: null,
      idpSessionId: null,
      ip: null,
      userAgent: null,
    });

    await sessions.create('u1', { authMethod: 'oidc', providerId: 'p1', idpSessionId: 'sid', ip: '203.0.113.7', userAgent: 'UA', ttlHours: 1 });
    const data = prisma.session.create.mock.calls[1][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ authMethod: 'oidc', providerId: 'p1', idpSessionId: 'sid', ip: '203.0.113.7', userAgent: 'UA' });
    // A provider's own lifetime replaces AUTH_SESSION_TTL_HOURS.
    expect((data.expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(3600_000);
  });

  it('touches last_seen_at at most once a minute, in one guarded statement', () => {
    const prisma = fakePrisma();
    const sessions = new SessionsService(prisma as never, config as never);
    const now = new Date('2026-10-18T12:00:00Z');
    sessions.touch('s1', now);
    const { where, data } = prisma.session.updateMany.mock.calls[0][0] as never as {
      where: { id: string; OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: Date } }] };
      data: { lastSeenAt: Date };
    };
    expect(where.id).toBe('s1');
    expect(where.OR[0]).toEqual({ lastSeenAt: null });
    expect(where.OR[1].lastSeenAt.lt.getTime()).toBe(now.getTime() - 60_000);
    expect(data.lastSeenAt).toBe(now);
  });

  it('never lets a failed touch reach the request', async () => {
    const prisma = fakePrisma();
    prisma.session.updateMany.mockRejectedValueOnce(new Error('db down'));
    const sessions = new SessionsService(prisma as never, config as never);
    expect(() => sessions.touch('s1')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it("revokes a session only when it is the caller's own", async () => {
    const prisma = fakePrisma();
    const sessions = new SessionsService(prisma as never, config as never);
    expect(await sessions.revokeOwn('u1', 's1')).toBe(true);
    expect(prisma.session.updateMany.mock.calls[0][0].where).toEqual({ id: 's1', userId: 'u1', revokedAt: null });

    prisma.session.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sessions.revokeOwn('u1', 'someone-elses')).toBe(false);
  });

  it('lists live sessions, marks the current one, and reads an unknown method as password', async () => {
    const prisma = fakePrisma();
    const at = new Date('2026-10-18T10:00:00Z');
    prisma.session.findMany.mockResolvedValueOnce([
      { id: 's1', authMethod: 'oidc', providerId: 'p1', ip: '203.0.113.7', userAgent: 'UA', createdAt: at, lastSeenAt: at, expiresAt: at },
      { id: 's2', authMethod: 'kerberos', providerId: null, ip: null, userAgent: null, createdAt: at, lastSeenAt: null, expiresAt: at },
    ]);
    const sessions = new SessionsService(prisma as never, config as never);
    const list = await sessions.listForUser('u1', 's2');
    const where = prisma.session.findMany.mock.calls[0][0] as never as { where: Record<string, unknown> };
    expect(where.where).toMatchObject({ userId: 'u1', revokedAt: null });
    expect(list.map((s) => [s.id, s.authMethod, s.providerName, s.current, s.lastSeenAt])).toEqual([
      ['s1', 'oidc', 'Corp SSO', false, at.toISOString()],
      ['s2', 'password', null, true, null],
    ]);
    // One name lookup for the distinct provider ids, none at all without any.
    expect(prisma.identityProvider.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ['p1'] } } });
  });

  it('returns how many sessions revokeAllForUser signed out', async () => {
    const prisma = fakePrisma();
    prisma.session.updateMany.mockResolvedValueOnce({ count: 3 });
    const sessions = new SessionsService(prisma as never, config as never);
    expect(await sessions.revokeAllForUser('u1')).toBe(3);
  });
});

describe('TokenAuthService session resolution', () => {
  it('puts the method and provider on the principal and touches last_seen_at', async () => {
    const user = {
      id: 'u1', email: 'a@example.com', displayName: 'A', isAdmin: false, locale: 'en',
      emailVerifiedAt: new Date(), disabledAt: null, avatarKey: null, avatarUpdatedAt: null,
    };
    const sessions = {
      resolve: vi.fn(async () => ({ id: 's1', authMethod: 'oidc', providerId: 'p1', createdAt: new Date('2026-10-18T09:00:00Z'), user })),
      touch: vi.fn(),
    };
    const auth = new TokenAuthService(config as never, {} as never, sessions as never, {} as never);
    const principal = await auth.resolve('ks_x');
    // sessionCreatedAt is what a workspace's session age cap reads (#75 phase 4).
    expect(principal).toMatchObject({ mode: 'session', sessionId: 's1', authMethod: 'oidc', providerId: 'p1', sessionCreatedAt: '2026-10-18T09:00:00.000Z' });
    expect(sessions.touch).toHaveBeenCalledWith('s1');

    // /me reports it for a session, and null for anything that is not one.
    expect(toMeResponse(principal, [], false).authMethod).toBe('oidc');
    expect(toMeResponse({ ...principal, mode: 'api-key' }, [], false).authMethod).toBeNull();
  });

  it('reads a legacy session as a password session', async () => {
    const user = {
      id: 'u1', email: 'a@example.com', displayName: 'A', isAdmin: false, locale: 'en',
      emailVerifiedAt: null, disabledAt: null, avatarKey: null, avatarUpdatedAt: null,
    };
    const sessions = { resolve: vi.fn(async () => ({ id: 's1', authMethod: 'password', providerId: null, createdAt: new Date(), user })), touch: vi.fn() };
    const auth = new TokenAuthService(config as never, {} as never, sessions as never, {} as never);
    const principal = await auth.resolve('ks_x');
    expect(principal.authMethod).toBe('password');
    expect('providerId' in principal).toBe(false);
  });
});
