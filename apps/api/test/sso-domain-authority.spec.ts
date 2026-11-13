import { describe, expect, it, vi } from 'vitest';
import { SsoLoginService } from '../src/auth/sso/sso-login.service.js';
import { RoleSyncService } from '../src/auth/sso/role-sync.service.js';
import { fakeConfig, fakePrisma, identityProvidersHarness, WS, type Row } from './sso-fakes.js';

/**
 * GHSA-xj6f-x636-xrx8: `allowedDomains` is what a workspace admin types. A
 * provider speaks for a domain only when its workspace proved the domain in
 * DNS (a verified `sso_domains` row), or when it is platform-wide, whose list
 * only a platform admin may change. A first link to a platform admin's
 * account is refused outright.
 */

const OTHER_WS = '33333333-3333-4333-8333-333333333333';

function login() {
  const { prisma, db } = fakePrisma();
  const audit = { record: vi.fn(async () => undefined) };
  const service = new SsoLoginService(prisma as never, audit as never, new RoleSyncService(prisma as never, audit as never));
  const provider = (over: Row = {}) =>
    ({ id: 'idp-1', workspaceId: WS, kind: 'oidc', preset: 'keycloak', platformWide: false, jitEnabled: true, defaultRole: null, allowedDomains: ['victim.example'], groupsClaim: null, groupSyncMode: 'additive', ...over }) as never;
  const person = (email: string) => ({ subject: `sub-${email}`, email, emailVerified: true, displayName: null, groups: [], notes: [] }) as never;
  const user = (email: string, over: Row = {}) => {
    const row = { id: `user-${email}`, email, isAdmin: false, disabledAt: null, ...over };
    db.users.push(row);
    return row;
  };
  return { service, db, provider, person, user };
}

describe('SSO sign-in on a domain the workspace never proved', () => {
  it('refuses to link an existing account', async () => {
    const h = login();
    h.user('ceo@victim.example');
    const outcome = await h.service.resolve(h.provider(), h.person('ceo@victim.example'));
    expect(outcome).toMatchObject({ ok: false, error: 'domain-not-allowed' });
    expect(h.db.identities).toHaveLength(0);
  });

  it('refuses to create a new account', async () => {
    const h = login();
    const outcome = await h.service.resolve(h.provider(), h.person('new@victim.example'));
    expect(outcome).toMatchObject({ ok: false, error: 'domain-not-allowed' });
    expect(h.db.users).toHaveLength(0);
  });

  it('refuses a domain proven by another workspace', async () => {
    const h = login();
    h.db.ssoDomains.push({ domain: 'victim.example', workspaceId: OTHER_WS, verifiedAt: new Date() });
    h.user('ceo@victim.example');
    expect(await h.service.resolve(h.provider(), h.person('ceo@victim.example'))).toMatchObject({ ok: false, error: 'domain-not-allowed' });
  });

  it('links once the domain is verified in this workspace', async () => {
    const h = login();
    h.db.ssoDomains.push({ domain: 'victim.example', workspaceId: WS, verifiedAt: new Date() });
    h.user('ceo@victim.example');
    expect(await h.service.resolve(h.provider(), h.person('ceo@victim.example'))).toMatchObject({ ok: true });
  });

  it('a pending (unverified) claim is not proof', async () => {
    const h = login();
    h.db.ssoDomains.push({ domain: 'victim.example', workspaceId: WS, verifiedAt: null });
    expect(await h.service.resolve(h.provider(), h.person('new@victim.example'))).toMatchObject({ ok: false, error: 'domain-not-allowed' });
  });

  it('trusts a platform-wide provider’s list, which only a platform admin may change', async () => {
    const h = login();
    h.user('ada@victim.example');
    expect(await h.service.resolve(h.provider({ platformWide: true }), h.person('ada@victim.example'))).toMatchObject({ ok: true });
  });
});

describe('linking a platform admin by address', () => {
  it('is refused even on a verified domain', async () => {
    const h = login();
    h.db.ssoDomains.push({ domain: 'victim.example', workspaceId: WS, verifiedAt: new Date() });
    h.user('root@victim.example', { isAdmin: true });
    expect(await h.service.resolve(h.provider(), h.person('root@victim.example'))).toMatchObject({ ok: false, error: 'admin-link-refused' });
    expect(h.db.identities).toHaveLength(0);
  });
});

describe('saving a provider’s domains', () => {
  const admin = { userId: 'u1', isAdmin: false } as never;
  const platformAdmin = { userId: 'root', isAdmin: true } as never;
  const body = (allowedDomains: string[]) => ({ kind: 'oidc' as const, name: 'Corp', preset: 'keycloak' as const, issuer: 'https://idp.example/realms/corp', clientId: 'knowledge', allowedDomains });

  it('refuses a domain this workspace has not verified', async () => {
    const { svc } = identityProvidersHarness(fakeConfig());
    await expect(svc.create(WS, body(['victim.example']), admin)).rejects.toThrow(/providerDomainNotVerified/);
    await expect(svc.create(WS, body(['corp.example']), admin)).resolves.toMatchObject({ allowedDomains: ['corp.example'], unverifiedDomains: [] });
  });

  it('keeps a stored unverified domain on an unrelated edit, and names it as needing proof', async () => {
    const { svc, rows } = identityProvidersHarness(fakeConfig());
    const view = await svc.create(WS, body(['corp.example']), admin);
    rows[0]!.allowedDomains = ['corp.example', 'legacy.example'];
    const updated = await svc.update(WS, view.id, { name: 'Renamed', allowedDomains: ['corp.example', 'legacy.example'] }, admin);
    expect(updated.unverifiedDomains).toEqual(['legacy.example']);
  });

  it('lets only a platform admin change a platform-wide provider’s domains', async () => {
    const { svc, rows } = identityProvidersHarness(fakeConfig());
    const view = await svc.create(WS, body(['corp.example']), admin);
    rows[0]!.platformWide = true;
    await expect(svc.update(WS, view.id, { allowedDomains: ['victim.example'] }, admin)).rejects.toThrow(/platformWideDomainsAdminOnly/);
    await expect(svc.update(WS, view.id, { allowedDomains: ['victim.example'] }, platformAdmin)).resolves.toMatchObject({ unverifiedDomains: [] });
  });
});
