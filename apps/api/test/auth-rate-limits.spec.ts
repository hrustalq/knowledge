import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthRateLimitGuard } from '../src/auth/auth-rate-limit.guard.js';
import { AuthFlowController } from '../src/auth/auth-flow.controller.js';
import { MeController } from '../src/auth/me.controller.js';
import { CredentialsController } from '../src/connectors/credentials.controller.js';
import { ChatLinkController } from '../src/chat/chat-link.controller.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * #1092: every anonymous auth route that sends mail, burns scrypt or redeems a
 * token has a budget, and the account-security routes a person reaches from a
 * signed-in browser refuse an API key — a leaked key must not guess the
 * owner's password, sign them out, or take a credential over.
 */

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002';

/** A limiter that counts keys and grants `budget` hits per key. */
function limiter() {
  const counts = new Map<string, number>();
  return {
    counts,
    hit: vi.fn(async (key: string, limit: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= limit;
    }),
  };
}

function rateCtx(handler: keyof AuthFlowController, body: Record<string, unknown>, principal?: Partial<Principal>) {
  const req = { body, headers: {}, socket: { remoteAddress: '203.0.113.7' }, ip: '203.0.113.7', principal };
  const res = { setHeader: vi.fn() };
  return {
    getHandler: () => AuthFlowController.prototype[handler],
    getClass: () => AuthFlowController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

async function attemptsUntil429(handler: keyof AuthFlowController, body: Record<string, unknown>, principal?: Partial<Principal>) {
  const guard = new AuthRateLimitGuard(limiter() as never, new Reflector());
  for (let i = 1; i <= 200; i++) {
    try {
      await guard.canActivate(rateCtx(handler, body, principal));
    } catch (err) {
      expect((err as { getStatus(): number }).getStatus()).toBe(429);
      return i;
    }
  }
  return Infinity;
}

describe('auth rate limits (#1092)', () => {
  it.each([
    ['forgotPassword', { email: 'ada@example.com' }],
    ['signup', { email: 'ada@example.com', displayName: 'Ada', password: 'x' }],
    ['resetPassword', { token: 'kr_junk', password: 'x' }],
    ['verifyEmail', { token: 'kv_junk' }],
  ] as const)('%s answers 429 past its budget', async (handler, body) => {
    expect(await attemptsUntil429(handler, body)).toBeLessThan(Infinity);
  });

  it('forgot-password caps one address well below the per-IP budget', async () => {
    expect(await attemptsUntil429('forgotPassword', { email: 'ada@example.com' })).toBeLessThanOrEqual(6);
  });

  it('change-password is budgeted per account, whatever IP the guesses come from', async () => {
    const lim = limiter();
    const guard = new AuthRateLimitGuard(lim as never, new Reflector());
    let refused = 0;
    for (let i = 0; i < 30; i++) {
      const ctx = rateCtx('changePassword', { currentPassword: 'guess', newPassword: 'x' }, { userId: USER, mode: 'session' });
      // A fresh address every time: only the per-account key can stop this.
      (ctx as unknown as { switchToHttp(): { getRequest(): { socket: { remoteAddress: string } } } }).switchToHttp().getRequest().socket.remoteAddress = `198.51.100.${i}`;
      await guard.canActivate(ctx).catch(() => (refused += 1));
    }
    expect(refused).toBeGreaterThan(0);
    expect([...lim.counts.keys()].some((k) => k.includes(USER))).toBe(true);
  });
});

describe('account-security routes take a session, never an API key (#1092)', () => {
  const guard = new AclGuard(new Reflector(), {} as never, {} as never);
  const keyPrincipal = {
    userId: USER,
    mode: 'api-key',
    isAdmin: false,
    apiKey: { id: 'k', scope: 'write', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001' },
  } as unknown as Principal;
  const sessionPrincipal = { userId: USER, mode: 'session', isAdmin: false, sessionId: 's' } as unknown as Principal;

  const routes: Array<[string, object, string, string]> = [
    ['change-password', AuthFlowController, 'changePassword', 'POST'],
    ['session revoke', MeController, 'revokeSession', 'DELETE'],
    ['credential rotate', CredentialsController, 'rotate', 'PATCH'],
    ['credential delete', CredentialsController, 'remove', 'DELETE'],
    ['chat link preview', ChatLinkController, 'preview', 'POST'],
    ['chat link', ChatLinkController, 'link', 'POST'],
    ['chat unlink', ChatLinkController, 'unlink', 'DELETE'],
  ];

  function ctx(cls: object, handler: string, method: string, principal: Principal) {
    const request = { principal, method, params: {}, query: {}, body: {} };
    const proto = (cls as { prototype: Record<string, unknown> }).prototype;
    return {
      getHandler: () => proto[handler],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  }

  it.each(routes)('%s refuses a write key and lets a session through', async (_label, cls, handler, method) => {
    expect((cls as { prototype: Record<string, unknown> }).prototype[handler]).toBeTypeOf('function');
    await expect(guard.canActivate(ctx(cls, handler, method, keyPrincipal))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(cls, handler, method, sessionPrincipal))).resolves.toBe(true);
  });

  it('a workspace-pinned key does not create workspaces', async () => {
    const prisma = { workspace: { create: vi.fn() }, $transaction: vi.fn() };
    const svc = new WorkspacesService(prisma as never, {} as never, {} as never, {} as never, { get: () => true } as never);
    await expect(svc.create(keyPrincipal, 'escape')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
