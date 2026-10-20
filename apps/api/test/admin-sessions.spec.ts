import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AclGuard } from '../src/auth/acl.guard.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import type { Principal } from '../src/auth/principal.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';

/**
 * A platform admin's view of someone else's sessions (#292). What is pinned:
 * - list, revoke-one and revoke-all each check the person exists or guard by
 *   their id, and the two revokes are audited `auth.session_revoked` by admin;
 * - another user's session id on the revoke-one route is a 404, decided by
 *   the same guarded statement that would revoke it;
 * - all three routes are platform-admin only: a non-admin gets a 403;
 * - a revoked session resolves to nothing, so its token 401s next request.
 */

const config = { get: (k: string) => ({ AUTH_SESSION_TTL_HOURS: 720, AUTH_MODE: 'api-key' })[k] };
const ADMIN = { mode: 'session', userId: 'admin-1', isAdmin: true } as unknown as Principal;
const USER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

function harness(opts: { userExists?: boolean; revokedCount?: number } = {}) {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => (opts.userExists === false ? null : { id: USER })),
    },
    session: {
      updateMany: vi.fn(async () => ({ count: opts.revokedCount ?? 1 })),
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(async () => null as unknown),
    },
    identityProvider: {
      findMany: vi.fn(async () => [{ id: 'p1', name: 'Corp SAML' }]),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const sessions = new SessionsService(prisma as never, config as never);
  const users = new UsersService(prisma as never, sessions, {} as never, config as never, audit as never);
  return { prisma, audit, users };
}

describe('UsersService — a person\'s sessions (platform admin)', () => {
  it('lists the live sessions of an existing user, none of them marked current', async () => {
    const h = harness();
    const at = new Date('2026-10-20T10:00:00Z');
    h.prisma.session.findMany.mockResolvedValueOnce([
      { id: SESSION, authMethod: 'saml', providerId: 'p1', ip: '203.0.113.7', userAgent: 'UA', createdAt: at, lastSeenAt: at, expiresAt: at },
    ]);
    const { sessions } = await h.users.listSessions(USER);
    expect(h.prisma.session.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: USER, revokedAt: null } });
    expect(sessions).toEqual([
      expect.objectContaining({ id: SESSION, authMethod: 'saml', providerId: 'p1', providerName: 'Corp SAML', ip: '203.0.113.7', current: false }),
    ]);
  });

  it('404s listing an unknown user', async () => {
    const h = harness({ userExists: false });
    await expect(h.users.listSessions(USER)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('revokes one session in a statement guarded by the user id, and audits it', async () => {
    const h = harness();
    await h.users.revokeSession(ADMIN, USER, SESSION, '198.51.100.1');
    expect(h.prisma.session.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: SESSION, userId: USER, revokedAt: null },
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.session_revoked',
        actor: 'admin-1',
        target: USER,
        params: { sessionId: SESSION, by: 'admin' },
        ip: '198.51.100.1',
      }),
    );
  });

  it("404s another user's session id, and records nothing", async () => {
    // The guarded update matches no row: the id is someone else's (or gone).
    const h = harness({ revokedCount: 0 });
    await expect(h.users.revokeSession(ADMIN, USER, SESSION, null)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('revokes every live session and audits the count', async () => {
    const h = harness({ revokedCount: 3 });
    expect(await h.users.revokeSessions(ADMIN, USER, null)).toEqual({ revoked: 3 });
    expect(h.prisma.session.updateMany.mock.calls[0][0]).toMatchObject({ where: { userId: USER, revokedAt: null } });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.session_revoked', target: USER, params: { by: 'admin', count: 3 } }),
    );
  });

  it('404s revoking all for an unknown user', async () => {
    const h = harness({ userExists: false });
    await expect(h.users.revokeSessions(ADMIN, USER, null)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.session.updateMany).not.toHaveBeenCalled();
  });
});

describe('UsersController session routes are platform-admin only', () => {
  const guard = new AclGuard(new Reflector(), {} as never, {} as never);
  const routes = ['listSessions', 'revokeSession', 'revokeSessions'] as const;

  function ctx(principal: Principal, handler: (typeof routes)[number]) {
    const request = { principal, method: handler === 'listSessions' ? 'GET' : 'DELETE', params: { id: USER }, query: {}, body: {} };
    return {
      getHandler: () => UsersController.prototype[handler],
      getClass: () => UsersController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  }

  it.each(routes)('%s: a non-admin gets 403, a platform admin passes', async (handler) => {
    const member = { mode: 'session', userId: 'u-2', isAdmin: false } as unknown as Principal;
    await expect(guard.canActivate(ctx(member, handler))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(ADMIN, handler))).resolves.toBe(true);
  });
});

describe('a revoked session', () => {
  it('resolves to nothing, so its token gets 401 invalidSession on the next request', async () => {
    const prisma = {
      session: {
        findUnique: vi.fn(async () => ({
          id: SESSION,
          revokedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
          user: { id: USER, disabledAt: null },
        })),
      },
    };
    const sessions = new SessionsService(prisma as never, config as never);
    expect(await sessions.resolve('ks_revoked')).toBeNull();

    const auth = new TokenAuthService(config as never, prisma as never, sessions, {} as never);
    const refused = auth.resolve('ks_revoked');
    await expect(refused).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(refused).rejects.toThrow(/invalidSession/);
  });
});
