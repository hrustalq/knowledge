import { describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../src/config/env.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';

/**
 * #1093: the insecure branch is never the one you get by omission. A reset or
 * verification token reaches the response only when someone asked for that in
 * so many words, and a production process will not start serving everyone as
 * the dev principal because one line went missing.
 */

const base = {
  DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_ACCESS_KEY: 'x', S3_SECRET_KEY: 'x',
  S3_BUCKET: 'x', ARCADE_URL: 'http://x', ARCADE_DB: 'x', ARCADE_USER: 'x', ARCADE_PASSWORD: 'x',
};

describe('env (#1093): production refuses what fails open', () => {
  it('refuses NODE_ENV=production with AUTH_MODE=none', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/AUTH_MODE/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', AUTH_MODE: 'none' })).toThrow(/AUTH_MODE/);
  });

  it('lets an operator who says so in so many words run production without auth', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production', AUTH_ALLOW_NONE_IN_PRODUCTION: 'true' }).AUTH_MODE).toBe('none');
  });

  it('refuses the token echo under production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', AUTH_MODE: 'api-key', AUTH_ECHO_TOKENS: 'true' })).toThrow(
      /AUTH_ECHO_TOKENS/,
    );
  });

  it('boots production with real auth, and anything outside production as before', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production', AUTH_MODE: 'api-key' }).AUTH_ECHO_TOKENS).toBe(false);
    expect(validateEnv({ ...base }).AUTH_MODE).toBe('none');
    expect(validateEnv({ ...base, AUTH_ECHO_TOKENS: 'true' }).AUTH_ECHO_TOKENS).toBe(true);
  });
});

function flow(values: Record<string, unknown>) {
  const user = { id: 'u1', email: 'ada@example.com', disabledAt: null };
  const prisma = {
    withTransaction: async (fn: () => Promise<unknown>) => fn(),
    onCommit: () => undefined,
    user: { findUnique: vi.fn(async () => user) },
    passwordResetToken: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  const config = { get: (k: string) => values[k] };
  return new AuthFlowService(prisma as never, config as never, {} as never, { enqueue: vi.fn() } as never, {} as never, { enforcedDomainFor: async () => null } as never);
}

describe('forgot-password (#1093): no token in the answer by default', () => {
  it('answers without a token on real auth with NODE_ENV unset', async () => {
    const env = validateEnv({ ...base, AUTH_MODE: 'api-key' });
    const res = await flow(env).forgotPassword('ada@example.com');
    expect(res).toEqual({ ok: true });
  });

  it('echoes the token only behind AUTH_ECHO_TOKENS', async () => {
    const env = validateEnv({ ...base, AUTH_MODE: 'api-key', AUTH_ECHO_TOKENS: 'true' });
    const res = await flow(env).forgotPassword('ada@example.com');
    expect(res).toMatchObject({ ok: true, debugToken: expect.stringMatching(/^kr_/) });
  });
});
