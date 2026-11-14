import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';

/**
 * #1143: a disabled account spends the same work as a wrong password — one
 * scrypt — so login timing cannot tell a disabled account from a live one.
 */
const calls = vi.hoisted(() => ({ verify: 0, burn: 0 }));
vi.mock('../src/auth/password.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth/password.js')>();
  return {
    ...real,
    verifyPassword: async (...args: Parameters<typeof real.verifyPassword>) => {
      calls.verify += 1;
      return real.verifyPassword(...args);
    },
    burnPasswordCheck: async (...args: Parameters<typeof real.burnPasswordCheck>) => {
      calls.burn += 1;
      return real.burnPasswordCheck(...args);
    },
  };
});

const { AuthFlowService } = await import('../src/auth/auth-flow.service.js');
const { hashPassword } = await import('../src/auth/password.js');

describe('login on a disabled account (#1143)', () => {
  it('runs one password check, refuses with the uniform 401, and counts the failure', async () => {
    const user = { id: 'u1', email: 'ada@x.test', passwordHash: await hashPassword('right-password'), disabledAt: new Date(), isAdmin: false };
    const prisma = { user: { findUnique: vi.fn(async () => user) } };
    const backoff = { retryAfter: vi.fn(async () => 0), failed: vi.fn(async () => undefined), cleared: vi.fn(async () => undefined) };
    const policy = { enforcedDomainFor: vi.fn(async () => null), isBreakGlass: () => false };
    const audit = { record: vi.fn(async () => undefined) };
    const service = new AuthFlowService(prisma as never, { get: () => undefined } as never, {} as never, {} as never, audit as never, policy as never, backoff as never);
    calls.verify = 0;
    calls.burn = 0;
    for (const pw of ['right-password', 'wrong-password']) {
      await expect(service.login('ada@x.test', pw, { ip: '1.1.1.1', userAgent: null })).rejects.toMatchObject({ status: 401 });
    }
    expect(calls.verify + calls.burn).toBe(2);
    expect(backoff.failed).toHaveBeenCalledTimes(2);
  });
});
