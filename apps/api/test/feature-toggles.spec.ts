import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AclGuard } from '../src/auth/acl.guard.js';
import { ACCESS_META, FEATURE_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { FeaturesService } from '../src/auth/features.service.js';
import type { Principal } from '../src/auth/principal.js';

const WS = '11111111-1111-4111-8111-111111111111';

/** One route marked `@Feature('memos')` + `@Access('viewer', 'body')`, run through AclGuard. */
function run(principal: Partial<Principal>, opts: { disabled: string[]; member?: boolean }) {
  const spec: AccessSpec = { role: 'viewer', source: 'body', operator: false };
  const reflector = {
    get: (meta: string) => (meta === ACCESS_META ? spec : undefined),
    getAllAndOverride: (meta: string) => (meta === FEATURE_META ? 'memos' : undefined),
  };
  const access = {
    requireRole: vi.fn(async () => {
      if (opts.member === false) throw new ForbiddenException('not a member');
    }),
  };
  const prisma = { workspaceSettings: { findUnique: vi.fn(async () => ({ disabledFeatures: opts.disabled })) } };
  const guard = new AclGuard(reflector as never, access as never, {} as never, new FeaturesService(prisma as never));
  const request = { principal, method: 'GET', params: {}, query: {}, body: { workspaceId: WS } };
  return guard.canActivate({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as never);
}

describe('feature toggles (#604)', () => {
  const member = { mode: 'session', userId: 'u1' } as Principal;

  it('answers 404 on a route of a switched-off section, and passes it otherwise', async () => {
    await expect(run(member, { disabled: ['memos'] })).rejects.toMatchObject({ status: 404 });
    await expect(run(member, { disabled: ['analytics'] })).resolves.toBe(true);
  });

  it('refuses a non-member before saying whether the section is off', async () => {
    await expect(run(member, { disabled: ['memos'], member: false })).rejects.toMatchObject({ status: 403 });
  });

  it('holds under AUTH_MODE=none too', async () => {
    await expect(run({ mode: 'dev' } as Principal, { disabled: ['memos'] })).rejects.toMatchObject({ status: 404 });
  });

  it('reads a dropped catalogue value as nothing', async () => {
    await expect(run(member, { disabled: ['memos-v0'] })).resolves.toBe(true);
  });
});
