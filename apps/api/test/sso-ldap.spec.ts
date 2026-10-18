import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { LDAP_DEFAULT_USER_FILTER } from '@knowledge/contracts';
import { decryptSecret, parseKey } from '../src/ai/secret-box.js';
import { IdentityProvidersService } from '../src/auth/sso/identity-providers.service.js';
import { identityFromLdapEntry, ldapUrlProblem, userFilterFor, userFilterValid } from '../src/auth/sso/ldap-profile.js';
import { LdapService } from '../src/auth/sso/ldap.service.js';
import { OidcService } from '../src/auth/sso/oidc.service.js';
import { SamlService } from '../src/auth/sso/saml.service.js';
import { noAuthPolicy } from './auth-policy-fakes.js';
import { fakeConfig, ssoHarness, WS, type Row } from './sso-fakes.js';

/**
 * LDAP sign-in (#75 phase 7) against an in-memory directory standing in for
 * `ldapts`'s `Client`. Everything else is real: the filter escaping and the
 * error classes come from ldapts itself, and the sign-in runs through the
 * same `SsoLoginService` and `issueSession` as OIDC and SAML.
 */

// ---------------------------------------------------------------- fake directory

const dir = vi.hoisted(() => ({
  entries: [] as Record<string, unknown>[],
  /** dn → password. */
  passwords: new Map<string, string>(),
  calls: [] as string[],
  clients: 0,
  options: [] as { url: string; tlsOptions?: unknown }[],
  down: false,
}));

vi.mock('ldapts', async (importOriginal) => {
  const real = await importOriginal<typeof import('ldapts')>();
  class Client {
    constructor(options: { url: string; tlsOptions?: unknown }) {
      dir.clients++;
      dir.options.push(options);
    }
    async startTLS() {
      dir.calls.push('startTLS');
    }
    async bind(dn: string, password: string) {
      if (dir.down) throw new Error('connect ECONNREFUSED');
      dir.calls.push(`bind:${dn}`);
      if (dir.passwords.get(dn) !== password) throw new real.InvalidCredentialsError('Invalid Credentials');
    }
    async search(_base: string, opts: { filter: string; sizeLimit?: number }) {
      dir.calls.push(`search:${opts.filter}`);
      // A server matches the filter's *escaped* value: an entry is found only when the typed text was escaped to its own value.
      const hits = dir.entries.filter((e) =>
        ['uid', 'mail'].some((a) => typeof e[a] === 'string' && opts.filter.includes(`(${a}=${real.Filter.escape(e[a] as string)})`)),
      );
      if (opts.sizeLimit && hits.length > opts.sizeLimit) throw new real.SizeLimitExceededError('Size Limit Exceeded');
      return { searchEntries: hits, searchReferences: [] };
    }
    async unbind() {
      dir.calls.push('unbind');
    }
  }
  return { ...real, Client };
});

const SVC = 'cn=knowledge,ou=services,dc=corp,dc=example';
const ADA = 'uid=ada,ou=people,dc=corp,dc=example';

beforeEach(() => {
  dir.entries = [
    {
      dn: ADA,
      uid: 'ada',
      mail: 'Ada@Corp.Example',
      displayName: 'Ada Lovelace',
      entryUUID: '0D7A2C4E-0000-4000-8000-00000000ADA0',
      memberOf: ['cn=editors,ou=groups,dc=corp,dc=example'],
    },
  ];
  dir.passwords = new Map([
    [SVC, ''],
    [ADA, 'correct horse'],
  ]);
  dir.calls = [];
  dir.clients = 0;
  dir.options = [];
  dir.down = false;
});

const meta = { ip: '203.0.113.9', userAgent: 'Browser/1' };
const LDAP = { url: 'ldaps://dir.corp.example', startTls: false, bindDn: SVC, baseDn: 'ou=people,dc=corp,dc=example', userFilter: null };
const harness = (over: Row = {}) => ssoHarness(fakeConfig({ AUTH_LDAP_ENABLED: true, ...over }), { kind: 'ldap', preset: 'generic', name: 'Corp directory', config: LDAP });

const failures = (h: ReturnType<typeof harness>) => h.failures().map((f) => f.error as string);

// ---------------------------------------------------------------- pure

describe('LDAP filters, URLs and entries', () => {
  it('escapes every filter metacharacter in the typed username (RFC 4515)', () => {
    const filter = userFilterFor('(uid={username})', 'a*)(uid=*)\\');
    expect(filter).toBe('(uid=a\\2a\\29\\28uid=\\2a\\29\\5c)');
    expect(userFilterFor(null, 'ada')).toBe(LDAP_DEFAULT_USER_FILTER.replaceAll('{username}', 'ada'));
    expect(userFilterFor('(|(uid={username})(mail={username}))', 'x(')).toBe('(|(uid=x\\28)(mail=x\\28))');
  });

  it.each([
    ['(uid={username})', true],
    ['(&(objectClass=person)(sAMAccountName={username}))', true],
    ['uid={username}', false],
    ['(uid=ada)', false],
    ['(&(uid={username})', false],
    ['(uid={username}))(', false],
  ])('accepts a user filter %s: %s', (filter, ok) => {
    expect(userFilterValid(filter)).toBe(ok);
  });

  it.each([
    ['ldaps://dc.corp.example:636', false, false, null],
    ['ldap://dc.corp.example', true, false, null],
    ['ldap://dc.corp.example', false, false, 'insecure'],
    ['ldap://dc.corp.example', false, true, null],
    ['https://dc.corp.example', false, false, 'invalid'],
    ['ldaps://dc.corp.example/ou=people', false, false, 'invalid'],
    ['ldaps://admin:pw@dc.corp.example', false, false, 'invalid'],
    ['not a url', false, false, 'invalid'],
  ])('judges %s (StartTLS %s, insecure allowed %s) → %s', (url, startTls, allowInsecure, problem) => {
    expect(ldapUrlProblem({ url, startTls }, allowInsecure)).toBe(problem);
  });

  it('takes the immutable id as the subject: entryUUID, else AD objectGUID as AD prints it', () => {
    const config = { ...LDAP, emailAttribute: null, nameAttribute: null };
    const ok = identityFromLdapEntry(dir.entries[0], config, 'memberOf');
    expect(ok).toMatchObject({
      ok: true,
      identity: { subject: '0d7a2c4e-0000-4000-8000-00000000ada0', email: 'ada@corp.example', emailVerified: true, displayName: 'Ada Lovelace', groups: ['cn=editors,ou=groups,dc=corp,dc=example'] },
    });
    const guid = Buffer.from('2a9f7a3c4b1d2e4f8a1b2c3d4e5f6a7b', 'hex');
    const ad = identityFromLdapEntry({ dn: 'CN=Ada', objectGUID: guid, mail: 'ada@corp.example', cn: 'Ada' }, config, 'memberOf');
    expect(ad).toMatchObject({ ok: true, identity: { subject: '3c7a9f2a-1d4b-4f2e-8a1b-2c3d4e5f6a7b', displayName: 'Ada' } });
    expect(identityFromLdapEntry({ dn: ADA, mail: 'ada@corp.example' }, config, 'memberOf')).toMatchObject({ ok: false, error: 'id-token-invalid' });
  });
});

// ---------------------------------------------------------------- sign-in

describe('LDAP sign-in', () => {
  it('binds as the service account, finds the entry, binds as the person, and opens an ldap session', async () => {
    const h = harness();
    const p = h.provider();
    const res = await h.sso.ldapLogin(p.id, 'ada', 'correct horse', meta);

    expect(res.token).toMatch(/^ks_/);
    expect(dir.calls).toEqual([`bind:${SVC}`, `search:${LDAP_DEFAULT_USER_FILTER.replaceAll('{username}', 'ada')}`, `bind:${ADA}`, 'unbind']);
    expect(h.sessions.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ authMethod: 'ldap', providerId: p.id }));
    // JIT, as for every SSO kind: the directory's address, verified, in an allowed domain.
    expect(h.db.users).toEqual([expect.objectContaining({ email: 'ada@corp.example', passwordHash: null, displayName: 'Ada Lovelace' })]);
    expect(h.db.identities[0]).toMatchObject({ providerId: p.id, subject: '0d7a2c4e-0000-4000-8000-00000000ada0' });
    expect(h.db.members).toEqual([expect.objectContaining({ workspaceId: WS, role: 'editor', source: 'jit' })]);
  });

  it('answers a wrong password, an unknown user and an empty password with the same 401', async () => {
    const h = harness();
    const p = h.provider();
    const answers: unknown[] = [];
    for (const [user, password] of [
      ['ada', 'wrong'],
      ['nobody', 'correct horse'],
      ['ada', ''],
    ]) {
      const err = await h.sso.ldapLogin(p.id, user, password, meta).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      answers.push((err as UnauthorizedException).getResponse());
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    // The audit row tells them apart; the person never does.
    expect(failures(h)).toEqual([expect.stringMatching(/^wrong-password \(ada\)/), expect.stringMatching(/^no-entry \(nobody\)/), expect.stringMatching(/^empty-password/)]);
    expect(h.sessions.create).not.toHaveBeenCalled();
  });

  it('never opens a socket for an empty password: that bind is unauthenticated, and many servers accept it', async () => {
    const h = harness();
    const p = h.provider();
    await expect(h.sso.ldapLogin(p.id, 'ada', '', meta)).rejects.toThrow(UnauthorizedException);
    expect(dir.clients).toBe(0);
  });

  it('cannot be steered by filter syntax in the username', async () => {
    const h = harness();
    const p = h.provider();
    await expect(h.sso.ldapLogin(p.id, '*', 'correct horse', meta)).rejects.toThrow(UnauthorizedException);
    await expect(h.sso.ldapLogin(p.id, 'ada)(uid=*', 'correct horse', meta)).rejects.toThrow(UnauthorizedException);
    expect(dir.calls.filter((c) => c.startsWith('search:'))).toEqual([
      expect.stringContaining('(uid=\\2a)'),
      expect.stringContaining('(uid=ada\\29\\28uid=\\2a)'),
    ]);
  });

  it('refuses an ambiguous match rather than pick one', async () => {
    const h = harness();
    const p = h.provider();
    dir.entries.push({ ...dir.entries[0], dn: 'uid=ada,ou=contractors,dc=corp,dc=example', entryUUID: randomUUID() });
    dir.entries.push({ ...dir.entries[0], dn: 'uid=ada,ou=old,dc=corp,dc=example', entryUUID: randomUUID() });
    await expect(h.sso.ldapLogin(p.id, 'ada', 'correct horse', meta)).rejects.toThrow(UnauthorizedException);
    expect(failures(h)).toEqual([expect.stringMatching(/^ambiguous/)]);
  });

  it('says the directory is unreachable when it is, which reveals nothing about the account', async () => {
    const h = harness();
    const p = h.provider();
    dir.down = true;
    await expect(h.sso.ldapLogin(p.id, 'ada', 'correct horse', meta)).rejects.toThrow(ServiceUnavailableException);
  });

  it('refuses plain ldap:// without StartTLS at sign-in too, and upgrades before the first bind when it is on', async () => {
    const h = harness();
    const clear = h.provider({ config: { ...LDAP, url: 'ldap://dir.corp.example' } });
    await expect(h.sso.ldapLogin(clear.id, 'ada', 'correct horse', meta)).rejects.toThrow(ServiceUnavailableException);
    expect(dir.clients).toBe(0);

    const tls = h.provider({ config: { ...LDAP, url: 'ldap://dir.corp.example', startTls: true } });
    await h.sso.ldapLogin(tls.id, 'ada', 'correct horse', meta);
    expect(dir.calls[0]).toBe('startTLS');
  });

  it('gives the client TLS options only for ldaps:// — ldapts reads any as TLS from the first byte', async () => {
    const h = harness({ AUTH_LDAP_ALLOW_INSECURE: true });
    for (const config of [LDAP, { ...LDAP, url: 'ldap://dir.corp.example', startTls: true }, { ...LDAP, url: 'ldap://dir.corp.example' }]) {
      await h.sso.ldapLogin(h.provider({ config }).id, 'ada', 'correct horse', meta);
    }
    expect(dir.options.map((o) => [o.url, o.tlsOptions !== undefined])).toEqual([
      ['ldaps://dir.corp.example', true],
      ['ldap://dir.corp.example', false],
      ['ldap://dir.corp.example', false],
    ]);
  });

  it('a clear-text provider works only while AUTH_LDAP_ALLOW_INSECURE says so', async () => {
    const h = harness({ AUTH_LDAP_ALLOW_INSECURE: true });
    const clear = h.provider({ config: { ...LDAP, url: 'ldap://dir.corp.example' } });
    await expect(h.sso.ldapLogin(clear.id, 'ada', 'correct horse', meta)).resolves.toMatchObject({ token: expect.any(String) });
    expect(dir.calls).not.toContain('startTLS');
  });

  it('is a 404 while AUTH_LDAP_ENABLED is off, and for a provider of another kind', async () => {
    const off = harness({ AUTH_LDAP_ENABLED: false });
    const p = off.provider();
    await expect(off.sso.ldapLogin(p.id, 'ada', 'correct horse', meta)).rejects.toThrow(NotFoundException);
    const h = harness();
    const oidc = h.provider({ kind: 'oidc', preset: 'keycloak' });
    await expect(h.sso.ldapLogin(oidc.id, 'ada', 'correct horse', meta)).rejects.toThrow(NotFoundException);
    expect(dir.clients).toBe(0);
  });

  it('names why a correct password still cannot sign in, as the redirect kinds do', async () => {
    const h = harness();
    const p = h.provider({ jitEnabled: false });
    const err = (await h.sso.ldapLogin(p.id, 'ada', 'correct horse', meta).catch((e: unknown) => e)) as ForbiddenException;
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ loginError: 'jit-disabled' });
  });

  it('answers a disabled account like a wrong password, as password sign-in does', async () => {
    const h = harness();
    const p = h.provider();
    await h.sso.ldapLogin(p.id, 'ada', 'correct horse', meta);
    h.db.users[0].disabledAt = new Date();
    await expect(h.sso.ldapLogin(p.id, 'ada', 'correct horse', meta)).rejects.toThrow(UnauthorizedException);
    expect(failures(h).at(-1)).toMatch(/^disabled/);
  });

  it('appears on the login page and in discovery only while LDAP is enabled', async () => {
    const on = harness();
    on.provider();
    expect((await on.sso.loginProviders(WS)).providers.map((p) => p.kind)).toEqual(['ldap']);
    expect((await on.sso.discover('ada@corp.example')).providers.map((p) => p.kind)).toEqual(['ldap']);
    const off = harness({ AUTH_LDAP_ENABLED: false });
    off.provider();
    expect((await off.sso.loginProviders(WS)).providers).toEqual([]);
    expect((await off.sso.discover('ada@corp.example')).method).toBe('password');
  });
});

// ---------------------------------------------------------------- provider setup

describe('LDAP provider setup', () => {
  const ENC_KEY = randomBytes(32).toString('base64');

  function providers(over: Row = {}) {
    const rows: Row[] = [];
    const prisma = {
      identityProvider: {
        create: vi.fn(async ({ data }: Row) => {
          const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), enabled: false, showOnLogin: true, platformWide: false, jitEnabled: false, defaultRole: null, allowedDomains: [], groupsClaim: null, groupSyncMode: 'additive', sessionTtlHours: null, secretCipher: null, ...data };
          rows.push(row);
          return row;
        }),
        findFirst: vi.fn(async ({ where }: Row) => rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null),
        update: vi.fn(async ({ where, data }: Row) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
        findMany: vi.fn(async () => rows),
      },
    };
    const cfg = fakeConfig({ SETTINGS_ENCRYPTION_KEY: ENC_KEY, AUTH_LDAP_ENABLED: true, ...over });
    const audit = { record: vi.fn(async () => undefined) };
    const svc = new IdentityProvidersService(
      prisma as never,
      cfg as never,
      new OidcService(cfg as never),
      audit as never,
      noAuthPolicy as never,
      new SamlService(cfg as never),
      new LdapService(cfg as never),
    );
    return { svc, rows, audit };
  }
  const admin = { userId: 'u1', isAdmin: false } as never;
  const body = { kind: 'ldap' as const, name: 'Corp directory', ldapUrl: 'ldaps://127.0.0.1:636', bindDn: SVC, bindPassword: 's3cret', baseDn: 'ou=people,dc=corp,dc=example' };

  it('stores the bind password write-only, and the view carries the settings', async () => {
    const { svc, rows, audit } = providers();
    const view = await svc.create(WS, body, admin);
    expect(view).toMatchObject({ kind: 'ldap', hasSecret: true, redirectUri: '', backchannelLogoutUri: null, saml: null });
    expect(view.ldap).toEqual({ url: 'ldaps://127.0.0.1:636', startTls: false, bindDn: SVC, baseDn: body.baseDn, userFilter: null, emailAttribute: null, nameAttribute: null });
    expect(JSON.stringify(view)).not.toContain('s3cret');
    expect(decryptSecret(rows[0].secretCipher, parseKey(ENC_KEY))).toBe('s3cret');
    // The audit row says the password changed, never to what.
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('s3cret');
    expect((audit.record.mock.calls as unknown as Row[][])[0][0].params.fields).toContain('bindPassword');

    // A stray clientSecret is not the bind password; an absent bindPassword keeps it.
    await svc.update(WS, view.id, { clientSecret: 'nope', baseDn: 'dc=corp,dc=example' }, admin);
    expect(decryptSecret(rows[0].secretCipher, parseKey(ENC_KEY))).toBe('s3cret');
    expect(rows[0].config.baseDn).toBe('dc=corp,dc=example');
  });

  it('lists ldap among the kinds a provider may have only while it is enabled', async () => {
    expect((await providers().svc.list(WS)).kinds).toEqual(['oidc', 'saml', 'ldap']);
    const off = providers({ AUTH_LDAP_ENABLED: false });
    expect((await off.svc.list(WS)).kinds).toEqual(['oidc', 'saml']);
    await expect(off.svc.create(WS, body, admin)).rejects.toThrow('error.sso.kindNotSupported');
  });

  it.each([
    ['plain ldap:// without StartTLS', { ldapUrl: 'ldap://127.0.0.1' }, 'error.sso.ldapInsecure'],
    ['an https URL', { ldapUrl: 'https://127.0.0.1' }, 'error.sso.ldapUrlInvalid'],
    ['a missing base DN', { baseDn: ' ' }, 'error.sso.baseDnRequired'],
    ['a filter without {username}', { userFilter: '(uid=ada)' }, 'error.sso.userFilterInvalid'],
    ['an unbalanced filter', { userFilter: '(&(uid={username})' }, 'error.sso.userFilterInvalid'],
  ])('refuses %s', async (_l, over, key) => {
    const { svc } = providers({ AUTH_SSO_ALLOW_PRIVATE_URLS: true });
    await expect(svc.create(WS, { ...body, ...over }, admin)).rejects.toThrow(BadRequestException);
    await expect(svc.create(WS, { ...body, ...over }, admin)).rejects.toThrow(key);
  });

  it('accepts plain ldap:// with StartTLS, and drops StartTLS for ldaps://', async () => {
    const { svc } = providers();
    expect((await svc.create(WS, { ...body, ldapUrl: 'ldap://127.0.0.1:389', startTls: true }, admin)).ldap).toMatchObject({ startTls: true });
    expect((await svc.create(WS, { ...body, startTls: true }, admin)).ldap).toMatchObject({ startTls: false });
  });

  it('refuses a private directory host unless AUTH_SSO_ALLOW_PRIVATE_URLS says it is on-prem', async () => {
    await expect(providers({ AUTH_SSO_ALLOW_PRIVATE_URLS: false }).svc.create(WS, body, admin)).rejects.toThrow('error.sso.ldapHostPrivate');
  });
});
