import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

/**
 * #1092: login spends one scrypt whatever the address, so response time does
 * not separate a registered address from an unknown one, or an account with a
 * password from one that signs in with SSO only.
 */

const scrypts = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const scrypt = ((...args: Parameters<typeof real.scrypt>) => {
    scrypts.count += 1;
    return (real.scrypt as (...a: unknown[]) => void)(...args);
  }) as typeof real.scrypt;
  return { ...real, scrypt, default: { ...real, scrypt } };
});

const { AuthFlowService } = await import('../src/auth/auth-flow.service.js');
const { hashPassword } = await import('../src/auth/password.js');

function flow(user: Record<string, unknown> | null) {
  const prisma = { user: { findUnique: vi.fn(async () => user) } };
  const config = { get: () => undefined };
  const policy = { enforcedDomainFor: vi.fn(async () => null), isBreakGlass: () => false };
  const audit = { record: vi.fn(async () => undefined) };
  return new AuthFlowService(prisma as never, config as never, {} as never, {} as never, audit as never, policy as never);
}

describe('login timing (#1092)', () => {
  beforeEach(() => void (scrypts.count = 0));

  it('runs scrypt for an unknown address', async () => {
    await expect(flow(null).login('nobody@example.test', 'guess')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(scrypts.count).toBe(1);
  });

  it('runs scrypt for an account with no password', async () => {
    const user = { id: 'u', email: 'sso@example.test', passwordHash: null, disabledAt: null, isAdmin: false };
    await expect(flow(user).login('sso@example.test', 'guess')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(scrypts.count).toBe(1);
  });

  it('runs scrypt once for a wrong password, as before', async () => {
    const passwordHash = await hashPassword('right');
    scrypts.count = 0;
    const user = { id: 'u', email: 'ada@example.test', passwordHash, disabledAt: null, isAdmin: false };
    await expect(flow(user).login('ada@example.test', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(scrypts.count).toBe(1);
  });
});
