import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { claimUnverifiedAccount } from '../src/auth/account-claim.js';

/** A Prisma stand-in that records every write the claim makes. */
function fakePrisma(opts: { claimed: boolean; boundCredentialIds?: string[] }) {
  const calls: Array<[string, string, unknown]> = [];
  const model = (name: string, extra: Record<string, unknown> = {}) =>
    new Proxy(extra, {
      get: (target, op: string) =>
        (target as Record<string, unknown>)[op] ??
        vi.fn(async (args: unknown) => {
          calls.push([name, op, args]);
          return { count: name === 'user' ? (opts.claimed ? 1 : 0) : 0 };
        }),
    });
  const prisma = {
    withTransaction: (fn: () => Promise<unknown>) => fn(),
    user: model('user'),
    session: model('session'),
    apiKey: model('apiKey'),
    passwordResetToken: model('passwordResetToken'),
    emailVerificationToken: model('emailVerificationToken'),
    chatIdentity: model('chatIdentity'),
    chatLinkCode: model('chatLinkCode'),
    plaudLink: model('plaudLink'),
    credential: model('credential'),
    connection: model('connection', {
      findMany: vi.fn(async () => (opts.boundCredentialIds ?? []).map((credentialId) => ({ credentialId }))),
    }),
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('claimUnverifiedAccount (#1094 leftover)', () => {
  it("ends the squatter's personal sign-ins: Plaud links, unbound credentials deleted, bound ones disowned", async () => {
    const { prisma, calls } = fakePrisma({ claimed: true, boundCredentialIds: ['cred-bound'] });
    expect(await claimUnverifiedAccount(prisma, 'u1')).toBe(true);
    expect(calls).toContainEqual(['plaudLink', 'deleteMany', { where: { userId: 'u1' } }]);
    expect(calls).toContainEqual(['chatLinkCode', 'updateMany', { where: { confirmedBy: 'u1', usedAt: null }, data: { usedAt: expect.any(Date) } }]);
    expect(calls).toContainEqual(['credential', 'deleteMany', { where: { userId: 'u1', id: { notIn: ['cred-bound'] } } }]);
    expect(calls).toContainEqual(['credential', 'updateMany', { where: { userId: 'u1' }, data: { userId: null } }]);
  });

  it('touches nothing on an account that was already verified', async () => {
    const { prisma, calls } = fakePrisma({ claimed: false });
    expect(await claimUnverifiedAccount(prisma, 'u1')).toBe(false);
    expect(calls.map(([name]) => name)).toEqual(['user']);
  });
});
