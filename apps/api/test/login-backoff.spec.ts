import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { ADDRESS_BACKOFF, LoginBackoff, PAIR_BACKOFF, backoffSeconds } from '../src/auth/login-backoff.js';

/** #1092 leftover: failed logins slow down per address and IP, then per address; never a hard lockout. */

function kv() {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      kv: {
        get: async (k: string) => data.get(k) ?? null,
        set: async (k: string, v: string) => void data.set(k, v),
        del: async (k: string) => Number(data.delete(k)),
      },
    },
  };
}

describe('backoffSeconds', () => {
  it('waits nothing before the threshold, then doubles up to the cap', () => {
    expect(backoffSeconds(4, PAIR_BACKOFF)).toBe(0);
    expect([5, 6, 7].map((n) => backoffSeconds(n, PAIR_BACKOFF))).toEqual([2, 4, 8]);
    expect(backoffSeconds(40, PAIR_BACKOFF)).toBe(900);
    expect(backoffSeconds(49, ADDRESS_BACKOFF)).toBe(0);
    expect(backoffSeconds(50, ADDRESS_BACKOFF)).toBe(60);
    expect(backoffSeconds(10_000, ADDRESS_BACKOFF)).toBe(900);
  });
});

describe('LoginBackoff', () => {
  it('holds the guessing IP after five failures, not another IP, and a success clears the address', async () => {
    const { store } = kv();
    const backoff = new LoginBackoff(store as never);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) await backoff.failed('ada@x.test', '1.1.1.1', t0);
    expect(await backoff.retryAfter('ada@x.test', '1.1.1.1', t0)).toBe(2);
    expect(await backoff.retryAfter('ada@x.test', '2.2.2.2', t0)).toBe(0);
    expect(await backoff.retryAfter('ada@x.test', '1.1.1.1', t0 + 2_000)).toBe(0);
    await backoff.cleared('ada@x.test', '1.1.1.1');
    expect(await backoff.retryAfter('ada@x.test', '1.1.1.1', t0)).toBe(0);
  });

  it('holds every IP once the address has failed fifty times in a row', async () => {
    const { store } = kv();
    const backoff = new LoginBackoff(store as never);
    for (let i = 0; i < 50; i++) await backoff.failed('ada@x.test', `10.0.0.${i}`, 5_000);
    expect(await backoff.retryAfter('ada@x.test', '9.9.9.9', 5_000)).toBe(60);
  });

  it('waits nothing when Redis is down', async () => {
    const backoff = new LoginBackoff({ kv: { get: async () => Promise.reject(new Error('down')) } } as never);
    expect(await backoff.retryAfter('ada@x.test', '1.1.1.1')).toBe(0);
  });
});

describe('AuthFlowService.login with a backoff', () => {
  const flow = (wait: number) => {
    const prisma = { user: { findUnique: vi.fn(async () => null) } };
    const backoff = { retryAfter: vi.fn(async () => wait), failed: vi.fn(async () => undefined), cleared: vi.fn(async () => undefined) };
    const config = { get: () => undefined };
    const policy = { enforcedDomainFor: vi.fn(async () => null), isBreakGlass: () => false };
    const audit = { record: vi.fn(async () => undefined) };
    const service = new AuthFlowService(prisma as never, config as never, {} as never, {} as never, audit as never, policy as never, backoff as never);
    return { service, prisma, backoff };
  };
  const meta = { ip: '1.1.1.1', userAgent: null };

  it('answers 429 with the wait, before any password is looked at', async () => {
    const { service, prisma } = flow(30);
    await expect(service.login('ada@x.test', 'pw', meta)).rejects.toMatchObject({ status: 429, retryAfterSec: 30 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('counts a failure', async () => {
    const { service, backoff } = flow(0);
    await expect(service.login('ada@x.test', 'pw', meta)).rejects.toMatchObject({ status: 401 });
    expect(backoff.failed).toHaveBeenCalledWith('ada@x.test', '1.1.1.1');
  });
});
