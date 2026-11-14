import { describe, expect, it, vi } from 'vitest';
import { SsoLoginService } from '../src/auth/sso/sso-login.service.js';
import { RoleSyncService } from '../src/auth/sso/role-sync.service.js';
import { fakePrisma, WS, type Row } from './sso-fakes.js';

/**
 * #1094: signup proves nothing about the address. When an identity provider
 * that speaks for the domain first links an account whose address was never
 * confirmed, whoever registered it first loses every way in they set up — the
 * password, live sessions, API keys, open reset links and linked chat
 * accounts — and the account becomes the provider's person, verified.
 */

function harness() {
  const { prisma, db } = fakePrisma();
  const extra = { keys: [] as Row[], resets: [] as Row[], verifications: [] as Row[], chats: [] as Row[] };
  const updateRows = (rows: Row[]) =>
    vi.fn(async ({ where, data }: Row) => {
      const hit = rows.filter((r) => r.userId === where.userId && Object.entries(where).every(([k, v]) => k === 'userId' || r[k] === v));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
  Object.assign(prisma, {
    apiKey: { updateMany: updateRows(extra.keys) },
    passwordResetToken: { updateMany: updateRows(extra.resets) },
    emailVerificationToken: { updateMany: updateRows(extra.verifications) },
    chatIdentity: {
      deleteMany: vi.fn(async ({ where }: Row) => {
        const before = extra.chats.length;
        extra.chats.splice(0, extra.chats.length, ...extra.chats.filter((c) => c.userId !== where.userId));
        return { count: before - extra.chats.length };
      }),
    },
  });
  (prisma.user as Row).updateMany = vi.fn(async ({ where, data }: Row) => {
    const hit = db.users.filter((u) => u.id === where.id && (!('emailVerifiedAt' in where) || u.emailVerifiedAt === where.emailVerifiedAt));
    hit.forEach((u) => Object.assign(u, data));
    return { count: hit.length };
  });
  const audit = { record: vi.fn(async () => undefined) };
  const service = new SsoLoginService(prisma as never, audit as never, new RoleSyncService(prisma as never, audit as never));
  const provider = { id: 'idp-1', workspaceId: WS, kind: 'oidc', preset: 'keycloak', platformWide: false, jitEnabled: true, defaultRole: null, allowedDomains: ['corp.example'], groupsClaim: null, groupSyncMode: 'additive' } as never;
  const person = { subject: 'sub-1', email: 'newhire@corp.example', emailVerified: true, displayName: null, groups: [], notes: [] } as never;

  /** The squatter's account, with one of everything. */
  const seed = (emailVerifiedAt: Date | null) => {
    const user = { id: 'u-1', email: 'newhire@corp.example', isAdmin: false, disabledAt: null, passwordHash: 'scrypt$squatter', emailVerifiedAt };
    db.users.push(user);
    db.sessions.push({ id: 's-1', userId: 'u-1', revokedAt: null });
    extra.keys.push({ id: 'k-1', userId: 'u-1', revokedAt: null });
    extra.resets.push({ id: 'r-1', userId: 'u-1', usedAt: null });
    extra.verifications.push({ id: 'v-1', userId: 'u-1', usedAt: null });
    extra.chats.push({ id: 'c-1', userId: 'u-1' });
    return user;
  };
  return { service, db, extra, provider, person, seed, audit };
}

describe('first SSO link to an unverified account (#1094)', () => {
  it("ends the squatter's password, sessions, keys, links and chat accounts, and verifies the address", async () => {
    const h = harness();
    const user = h.seed(null);
    expect(await h.service.resolve(h.provider, h.person)).toMatchObject({ ok: true });
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(h.db.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(h.extra.keys[0].revokedAt).toBeInstanceOf(Date);
    expect(h.extra.resets[0].usedAt).toBeInstanceOf(Date);
    expect(h.extra.verifications[0].usedAt).toBeInstanceOf(Date);
    expect(h.extra.chats).toHaveLength(0);
  });

  it('leaves a verified account exactly as it was', async () => {
    const h = harness();
    const user = h.seed(new Date('2026-01-01'));
    expect(await h.service.resolve(h.provider, h.person)).toMatchObject({ ok: true });
    expect(user.passwordHash).toBe('scrypt$squatter');
    expect(h.db.sessions[0].revokedAt).toBeNull();
    expect(h.extra.keys[0].revokedAt).toBeNull();
    expect(h.extra.chats).toHaveLength(1);
  });

  it('claims once: a later sign-in through the same link touches nothing', async () => {
    const h = harness();
    h.seed(null);
    await h.service.resolve(h.provider, h.person);
    h.db.sessions.push({ id: 's-2', userId: 'u-1', revokedAt: null });
    await h.service.resolve(h.provider, h.person);
    expect(h.db.sessions.find((s) => s.id === 's-2')!.revokedAt).toBeNull();
  });
});
