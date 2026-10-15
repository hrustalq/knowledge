import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  audienceClaimsMatch,
  foldSiteAudience,
  mergeAudienceClaims,
  normalizeAudienceClaims,
  siteAudienceClaimsErrors,
  siteViewerCanSee,
  type SiteAudienceRuleInput,
} from '@knowledge/contracts';
import { encryptSecret } from '../src/ai/secret-box.js';
import { SiteAudienceStamper, pathIds } from '../src/publishing/site-audience.stamper.js';
import { SiteAudiencesService } from '../src/publishing/site-audiences.service.js';
import { safeReturnPath } from '../src/public/public-sites.controller.js';
import { PublicSiteSearchService } from '../src/public/public-site-search.service.js';
import { SiteSessionService, verifyVisitorToken } from '../src/public/site-session.service.js';
import type { PublicKeyValueStore } from '../src/public/public-store.js';

/**
 * Site audiences (issue #77 phase 3, docs/features/44). What is pinned:
 * - the fold: rules only restrict, `members` outranks `visitors`, claims of
 *   nested `visitors` rules must all hold, and a subpage is never more open
 *   than its parent;
 * - visitor tokens: HS256 only, signed with the site's secret, `exp`
 *   required; anything else leaves the reader anonymous;
 * - sessions: a sign-in code works once and for its own site only, a member
 *   session ends with the membership, a visitor session with the secret, and
 *   a store outage reads as anonymous;
 * - management: a rule restamps every version before it answers, claims are
 *   validated, and the page must be one the site covers;
 * - search filters hidden rows in the statement itself;
 * - the session route redirects only within its own origin.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const KEY = Buffer.from(KEY_B64, 'base64');
const SECRET = 'site-visitor-secret';

function jwt(payload: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${enc(header)}.${enc(payload)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

describe('the audience fold (contracts)', () => {
  const rules = (entries: Array<[string, SiteAudienceRuleInput]>) => new Map(entries);

  it('no rule on the path is public; members outranks visitors wherever it sits', () => {
    expect(foldSiteAudience(['a', 'b'], rules([]))).toEqual({ audience: 'public', claims: null });
    expect(foldSiteAudience(['a', 'b'], rules([['a', { audience: 'members', claims: null }], ['b', { audience: 'visitors', claims: { plan: ['pro'] } }]]))).toEqual({
      audience: 'members',
      claims: null,
    });
    expect(foldSiteAudience(['a', 'b'], rules([['a', { audience: 'visitors', claims: null }], ['b', { audience: 'members', claims: null }]]))).toEqual({
      audience: 'members',
      claims: null,
    });
  });

  it('nested visitors rules must all hold: keys add up, a key in both keeps the values both allow', () => {
    const stamp = foldSiteAudience(
      ['a', 'b'],
      rules([
        ['a', { audience: 'visitors', claims: { plan: ['pro', 'enterprise'] } }],
        ['b', { audience: 'visitors', claims: { plan: ['enterprise'], region: ['eu'] } }],
      ]),
    );
    expect(stamp).toEqual({ audience: 'visitors', claims: { plan: ['enterprise'], region: ['eu'] } });
    expect(mergeAudienceClaims({ plan: ['pro'] }, { plan: ['free'] })).toEqual({ plan: [] }); // nobody matches
  });

  it('claims match on strings, numbers and booleans, scalar or array; anything else does not', () => {
    expect(audienceClaimsMatch({ plan: ['pro'] }, { plan: 'pro' })).toBe(true);
    expect(audienceClaimsMatch({ plan: ['pro'] }, { plan: ['free', 'pro'] })).toBe(true);
    expect(audienceClaimsMatch({ tier: ['2'], beta: ['true'] }, { tier: 2, beta: true })).toBe(true);
    expect(audienceClaimsMatch({ plan: ['pro'] }, { plan: { name: 'pro' } })).toBe(false);
    expect(audienceClaimsMatch({ plan: ['pro'] }, {})).toBe(false);
    expect(audienceClaimsMatch({ plan: [] }, { plan: 'pro' })).toBe(false);
    expect(audienceClaimsMatch(null, {})).toBe(true);
  });

  it('who sees what: members see all, visitors their matching pages, anonymous only public', () => {
    const visitors = { audience: 'visitors', audienceClaims: { plan: ['pro'] } };
    expect(siteViewerCanSee({ audience: 'members' }, { kind: 'member' })).toBe(true);
    expect(siteViewerCanSee(visitors, { kind: 'member' })).toBe(true);
    expect(siteViewerCanSee(visitors, { kind: 'visitor', claims: { plan: 'pro' } })).toBe(true);
    expect(siteViewerCanSee(visitors, { kind: 'visitor', claims: { plan: 'free' } })).toBe(false);
    expect(siteViewerCanSee({ audience: 'members' }, { kind: 'visitor', claims: {} })).toBe(false);
    expect(siteViewerCanSee(visitors, { kind: 'anonymous' })).toBe(false);
    expect(siteViewerCanSee({ audience: 'public' }, { kind: 'anonymous' })).toBe(true);
  });

  it('claims are validated and normalized', () => {
    expect(siteAudienceClaimsErrors({ plan: ['pro'] })).toEqual([]);
    expect(siteAudienceClaimsErrors(null)).toEqual([]);
    expect(siteAudienceClaimsErrors(['pro'])).toEqual(['claims']);
    expect(siteAudienceClaimsErrors({ plan: [] })).toEqual(['claims.plan']);
    expect(siteAudienceClaimsErrors({ 'bad key': ['x'] })).toEqual(['claims.bad key']);
    expect(siteAudienceClaimsErrors({ plan: [1] })).toEqual(['claims.plan']);
    expect(normalizeAudienceClaims({ z: [' a ', 'a', 'b'], a: ['x'] })).toEqual({ a: ['x'], z: ['a', 'b'] });
    expect(normalizeAudienceClaims({})).toBeNull();
  });

  it('a page is judged by its documents.path, top first', () => {
    expect(pathIds('c', '/a/b/c/')).toEqual(['a', 'b', 'c']);
    expect(pathIds('c', '/')).toEqual(['c']); // not repathed yet: only its own rule applies
  });
});

describe('visitor tokens', () => {
  it('accepts an HS256 token signed with the site’s secret and still current', () => {
    expect(verifyVisitorToken(jwt({ sub: 'v1', plan: 'pro', exp: inAnHour() }), SECRET)).toMatchObject({ sub: 'v1', plan: 'pro' });
  });

  it('refuses another secret, another algorithm, `none`, a tampered payload and a malformed token', () => {
    const good = jwt({ exp: inAnHour() });
    expect(verifyVisitorToken(jwt({ exp: inAnHour() }, 'another'), SECRET)).toBeNull();
    expect(verifyVisitorToken(jwt({ exp: inAnHour() }, SECRET, { alg: 'HS512' }), SECRET)).toBeNull();
    const [, payload] = good.split('.');
    expect(verifyVisitorToken(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`, SECRET)).toBeNull();
    const [h, , sig] = good.split('.');
    expect(verifyVisitorToken(`${h}.${Buffer.from(JSON.stringify({ exp: inAnHour(), plan: 'enterprise' })).toString('base64url')}.${sig}`, SECRET)).toBeNull();
    expect(verifyVisitorToken('not-a-jwt', SECRET)).toBeNull();
    expect(verifyVisitorToken('', SECRET)).toBeNull();
  });

  it('requires exp, and honours exp and nbf', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyVisitorToken(jwt({ sub: 'v1' }), SECRET)).toBeNull();
    expect(verifyVisitorToken(jwt({ exp: now - 1 }), SECRET)).toBeNull();
    expect(verifyVisitorToken(jwt({ exp: now + 60, nbf: now + 30 }), SECRET)).toBeNull();
  });
});

/** Redis GET/SET PX/GETDEL/DEL, in memory. */
class FakeStore implements PublicKeyValueStore {
  readonly rows = new Map<string, string>();
  down = false;
  async incr() {
    return 1;
  }
  async pexpire() {
    return 1;
  }
  async set(key: string, value: string) {
    this.rows.set(key, value);
    return 'OK';
  }
  async get(key: string) {
    if (this.down) throw new Error('redis down');
    return this.rows.get(key) ?? null;
  }
  async getdel(key: string) {
    const v = this.rows.get(key) ?? null;
    this.rows.delete(key);
    return v;
  }
  async del(key: string) {
    return this.rows.delete(key) ? 1 : 0;
  }
}

function sessions(opts: { authMode?: 'none' | 'api-key'; member?: boolean } = {}) {
  const store = new FakeStore();
  let member: { user: { disabledAt: Date | null } } | null = opts.member === false ? null : { user: { disabledAt: null } };
  const prisma = {
    workspaceMember: { findUnique: vi.fn(async () => member) },
    user: { findUnique: vi.fn(async () => ({ isAdmin: false, disabledAt: null })) },
  };
  const values: Record<string, unknown> = { SITE_VISITOR_TTL_MIN: 60, AUTH_MODE: opts.authMode ?? 'api-key', SETTINGS_ENCRYPTION_KEY: KEY_B64 };
  const service = new SiteSessionService({ kv: store } as never, prisma as never, { get: (k: string) => values[k] } as never);
  const site = { id: SITE, workspaceId: WS, visitorSecretCipher: encryptSecret(SECRET, KEY) as string | null };
  return { service, store, site, setMember: (m: typeof member) => (member = m) };
}

/** The `kn_site_<id>` cookie a session value would arrive in. */
const cookie = (session: string, siteId = SITE) => `other=1; kn_site_${siteId}=${session}`;

describe('SiteSessionService', () => {
  it('a member’s code works once, for its own site, and the session ends with the membership', async () => {
    const { service, site, setMember } = sessions();
    const code = await service.issueCode(SITE, USER);
    const opened = await service.redeemCode(site, code);
    expect(opened?.ttlMs).toBe(60 * 60_000);
    expect(await service.redeemCode(site, code)).toBeNull(); // spent
    expect(await service.viewer(site, cookie(opened!.session))).toEqual({ kind: 'member' });

    const forOther = await service.issueCode(OTHER_SITE, USER);
    expect(await service.redeemCode(site, forOther)).toBeNull();

    setMember(null);
    expect(await service.viewer(site, cookie(opened!.session))).toEqual({ kind: 'anonymous' });
  });

  it('a disabled account or a code for someone without a role opens nothing', async () => {
    const { service, site, setMember } = sessions({ member: false });
    expect(await service.redeemCode(site, await service.issueCode(SITE, USER))).toBeNull();
    setMember({ user: { disabledAt: new Date() } });
    expect(await service.redeemCode(site, await service.issueCode(SITE, USER))).toBeNull();
  });

  it('a session cookie is read for its own site only', async () => {
    const { service, site } = sessions();
    const opened = await service.redeemCode(site, await service.issueCode(SITE, USER));
    expect(await service.viewer(site, cookie(opened!.session, OTHER_SITE))).toEqual({ kind: 'anonymous' });
    expect(await service.viewer({ ...site, id: OTHER_SITE }, cookie(opened!.session, OTHER_SITE))).toEqual({ kind: 'anonymous' });
  });

  it('a visitor token opens a session with its claims, no longer than the token lives', async () => {
    const { service, site } = sessions();
    const exp = Math.floor(Date.now() / 1000) + 600;
    const opened = await service.redeemToken(site, jwt({ plan: 'pro', exp }));
    expect(opened!.ttlMs).toBeLessThanOrEqual(600_000);
    expect(opened!.ttlMs).toBeGreaterThan(590_000);
    expect(await service.viewer(site, cookie(opened!.session))).toEqual({ kind: 'visitor', claims: expect.objectContaining({ plan: 'pro' }) });
    expect(await service.redeemToken(site, jwt({ plan: 'pro', exp }, 'forged'))).toBeNull();
  });

  it('rotating or clearing the secret ends visitor sessions; without a secret no token is accepted', async () => {
    const { service, site } = sessions();
    const opened = await service.redeemToken(site, jwt({ exp: inAnHour() }));
    const rotated = { ...site, visitorSecretCipher: encryptSecret('new-secret', KEY) };
    expect(await service.viewer(rotated, cookie(opened!.session))).toEqual({ kind: 'anonymous' });
    const cleared = { ...site, visitorSecretCipher: null };
    expect(await service.viewer(cleared, cookie(opened!.session))).toEqual({ kind: 'anonymous' });
    expect(await service.redeemToken(cleared, jwt({ exp: inAnHour() }))).toBeNull();
  });

  it('a store outage reads as anonymous, and sign-out ends the session at once', async () => {
    const { service, site, store } = sessions();
    const opened = await service.redeemCode(site, await service.issueCode(SITE, USER));
    store.down = true;
    expect(await service.viewer(site, cookie(opened!.session))).toEqual({ kind: 'anonymous' });
    store.down = false;
    await service.end(SITE, cookie(opened!.session));
    expect(await service.viewer(site, cookie(opened!.session))).toEqual({ kind: 'anonymous' });
  });

  it('AUTH_MODE=none: the dev principal is a member', async () => {
    const { service, site } = sessions({ authMode: 'none', member: false });
    expect(await service.redeemCode(site, await service.issueCode(SITE, '00000000-0000-0000-0000-000000000000'))).not.toBeNull();
  });
});

describe('SiteAudienceStamper.restamp', () => {
  it('stamps every version’s rows from the rules, one statement per distinct stamp, in one transaction', async () => {
    const prisma = {
      siteVersion: { findMany: vi.fn(async () => [{ id: 'v1' }, { id: 'v-frozen' }]) },
      siteVersionPage: {
        findMany: vi.fn(async () => [{ documentId: 'a' }, { documentId: 'b' }, { documentId: 'c' }]),
        updateMany: vi.fn((args: unknown) => args),
      },
      siteAudienceRule: { findMany: vi.fn(async () => [{ documentId: 'b', audience: 'members', claims: null }]) },
      document: {
        findMany: vi.fn(async () => [
          { id: 'a', path: '/a/' },
          { id: 'b', path: '/a/b/' },
          { id: 'c', path: '/a/b/c/' },
        ]),
      },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    };
    await new SiteAudienceStamper(prisma as never).restamp(SITE);
    const ops = prisma.$transaction.mock.calls[0][0] as Array<{ where: { versionId: { in: string[] }; documentId: { in: string[] } }; data: { audience: string } }>;
    expect(ops).toHaveLength(2);
    const byAudience = Object.fromEntries(ops.map((o) => [o.data.audience, o.where.documentId.in]));
    expect(byAudience).toEqual({ public: ['a'], members: ['b', 'c'] });
    // Frozen versions too: what they freeze is content, not who may read it.
    expect(ops[0].where.versionId.in).toEqual(['v1', 'v-frozen']);
  });
});

describe('SiteAudiencesService', () => {
  function manager(opts: { key?: boolean; doc?: Record<string, unknown> | null } = {}) {
    const site = { id: SITE, workspaceId: WS, projectId: 'p1', rootDocumentId: null as string | null, visitorSecretCipher: null, visitorSecretSetAt: null };
    const doc = opts.doc === undefined ? { title: 'Pricing', path: '/root/pricing/', projectId: 'p1', archivedAt: null } : opts.doc;
    const prisma = {
      publishedSite: { findUnique: vi.fn(async () => site), update: vi.fn(async ({ data }: { data: object }) => Object.assign(site, data)) },
      document: { findUnique: vi.fn(async () => doc) },
      siteAudienceRule: {
        count: vi.fn(async () => 0),
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create, updatedAt: new Date() })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
    };
    const stamper = { restamp: vi.fn(async () => undefined) };
    const activity = { record: vi.fn(async () => undefined) };
    const values: Record<string, unknown> = { SETTINGS_ENCRYPTION_KEY: opts.key === false ? '' : KEY_B64, SITE_VISITOR_TTL_MIN: 1440 };
    const service = new SiteAudiencesService(prisma as never, stamper as never, activity as never, { get: (k: string) => values[k] } as never);
    return { service, prisma, stamper, site };
  }

  it('a rule restamps every version before it answers, and claims come back normalized', async () => {
    const { service, stamper } = manager();
    const rule = await service.setRule(SITE, 'pricing', { audience: 'visitors', claims: { plan: [' pro ', 'pro'] } });
    expect(rule).toMatchObject({ audience: 'visitors', claims: { plan: ['pro'] }, documentTitle: 'Pricing' });
    expect(stamper.restamp).toHaveBeenCalledWith(SITE);
    await service.removeRule(SITE, 'pricing');
    expect(stamper.restamp).toHaveBeenCalledTimes(2);
  });

  it('refuses bad claims, claims on a members rule, and a page the site does not cover', async () => {
    const { service, stamper } = manager();
    const bad = await service.setRule(SITE, 'pricing', { audience: 'visitors', claims: { plan: [] } }).catch((e) => e);
    expect(bad).toBeInstanceOf(BadRequestException);
    expect(bad.getResponse()).toMatchObject({ reason: 'site.audienceClaimsInvalid', fields: ['claims.plan'] });
    await expect(service.setRule(SITE, 'pricing', { audience: 'members', claims: { plan: ['pro'] } })).rejects.toBeInstanceOf(BadRequestException);

    const elsewhere = manager({ doc: { title: 'X', path: '/x/', projectId: 'another', archivedAt: null } });
    const err = await elsewhere.service.setRule(SITE, 'x', { audience: 'members' }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ reason: 'site.audiencePageNotInSite' });

    const underRoot = manager();
    underRoot.site.rootDocumentId = 'docs-root';
    await expect(underRoot.service.setRule(SITE, 'pricing', { audience: 'members' })).rejects.toBeInstanceOf(BadRequestException);
    expect(stamper.restamp).not.toHaveBeenCalled();
  });

  it('a visitor secret is shown once, stored under the secret box, and needs the key', async () => {
    const { service, prisma } = manager();
    const { secret } = await service.rotateVisitorSecret(SITE);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    const stored = (prisma.publishedSite.update.mock.calls[0] as unknown as [{ data: { visitorSecretCipher: string } }])[0].data.visitorSecretCipher;
    expect(stored.startsWith('gcm$')).toBe(true);
    expect(stored).not.toContain(secret);
    expect((await service.list(SITE)).visitorAuth.configured).toBe(true);

    const noKey = await manager({ key: false }).service.rotateVisitorSecret(SITE).catch((e) => e);
    expect(noKey).toBeInstanceOf(ConflictException);
    expect(noKey.getResponse()).toMatchObject({ reason: 'site.visitorSecretNeedsKey' });
  });
});

describe('search keeps hidden pages out in the statement itself', () => {
  function searcher(stamps: Array<{ documentId: string; parentId: string | null; audience: string; audienceClaims: unknown }>, viewer: unknown) {
    const latest = { id: 'v-latest', slug: 'latest' };
    const sites = { findById: vi.fn(async () => ({ id: SITE, defaultVersion: latest, versions: [latest] })), viewer: vi.fn(async () => viewer) };
    const prisma = { $queryRaw: vi.fn(async () => []), siteVersionPage: { findMany: vi.fn(async () => stamps) } };
    return { prisma, service: new PublicSiteSearchService(sites as never, prisma as never) };
  }
  const rows = [
    { documentId: 'pub', parentId: null, audience: 'public', audienceClaims: null },
    { documentId: 'secret', parentId: null, audience: 'members', audienceClaims: null },
  ];

  it('anonymous: only the visible ids are searched', async () => {
    const { service, prisma } = searcher(rows, { kind: 'anonymous' });
    await service.search(SITE, { q: 'pricing' });
    const values = (prisma.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    // The visibility fragment, beside the (here empty) facet filter (#205).
    const filter = values.find(
      (v) => typeof v === 'object' && v !== null && 'sql' in v && (v as { sql: string }).sql.includes('document_id'),
    ) as { sql: string; values: unknown[] };
    expect(filter.sql).toContain('document_id = ANY');
    expect(filter.values).toContainEqual(['pub']);
  });

  it('a member searches everything; a reader who may see nothing gets nothing without a query', async () => {
    const member = searcher(rows, { kind: 'member' });
    await member.service.search(SITE, { q: 'pricing' });
    const values = (member.prisma.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values.some((v) => typeof v === 'object' && v !== null && 'sql' in v && (v as { sql: string }).sql.includes('ANY'))).toBe(false);

    const none = searcher([rows[1]], { kind: 'anonymous' });
    expect(await none.service.search(SITE, { q: 'pricing' })).toEqual({ results: [] });
    expect(none.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('the session route’s redirect', () => {
  it('goes back only to a path on its own origin', () => {
    expect(safeReturnPath('/pub/acme/guides?x=1')).toBe('/pub/acme/guides?x=1');
    for (const bad of [undefined, '', 'https://evil.example', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/a b']) {
      expect(safeReturnPath(bad)).toBe('/');
    }
  });
});
