import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { BadRequestException, ForbiddenException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { activityKindFor, shareExpiryFor, shareNeedsPassword } from '@knowledge/contracts';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { PublishingSettingsService } from '../src/publishing/publishing-settings.service.js';
import { ShareLinksService, shareTokenHash } from '../src/publishing/share-links.service.js';
import { clientIp, PublicRateLimiter, PublicRateLimitGuard } from '../src/public/public-rate-limit.js';
import { PublicSharesController } from '../src/public/public-shares.controller.js';
import { PublicSharesService } from '../src/public/public-shares.service.js';
import { PublicStore, type PublicKeyValueStore } from '../src/public/public-store.js';
import { ShareUnlockService } from '../src/public/share-unlock.service.js';

/**
 * Share links (docs/features/43, issue #77 phase 1). What is pinned:
 * - the switches: off by default, the env is a ceiling, and an existing link
 *   404s the moment either is off;
 * - the token: only its hash is stored and looked up, and the link can be
 *   copied again only when there is a key to keep it under;
 * - the scope: a page or attachment outside the shared page/subtree is a 404,
 *   the same answer as a link that does not exist;
 * - expiry, revoke and the password gate, including that changing the password
 *   ends open sessions and that guessing is rate-limited, fail-closed;
 * - the response headers a shared page must carry, errors included.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIBLING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ATT_CHILD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ATT_SIBLING = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const USER = '33333333-3333-4333-8333-333333333333';
const KEY = Buffer.alloc(32, 7).toString('base64');

interface DocRow {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  path: string;
  depth: number;
  position: number;
  archivedAt: Date | null;
}

function pick<T extends object>(row: T, select?: Record<string, unknown>): Partial<T> {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((k) => [k, (row as Record<string, unknown>)[k]])) as Partial<T>;
}

/** Just enough Prisma for both services, in memory. */
function fakePrisma() {
  const docs: DocRow[] = [
    { id: ROOT, workspaceId: WS, parentId: null, title: 'Guide', path: `/${ROOT}/`, depth: 0, position: 0, archivedAt: null },
    { id: CHILD, workspaceId: WS, parentId: ROOT, title: 'Install', path: `/${ROOT}/${CHILD}/`, depth: 1, position: 0, archivedAt: null },
    { id: SIBLING, workspaceId: WS, parentId: null, title: 'Secret', path: `/${SIBLING}/`, depth: 0, position: 1, archivedAt: null },
    // Same id prefix shape, other tenant — must never resolve through WS's link.
    { id: FOREIGN, workspaceId: OTHER_WS, parentId: null, title: 'Foreign', path: `/${ROOT}/${FOREIGN}/`, depth: 1, position: 0, archivedAt: null },
  ];
  const attachments = [
    { id: ATT_CHILD, documentId: CHILD, status: 'ready' },
    { id: ATT_SIBLING, documentId: SIBLING, status: 'ready' },
  ];
  const shares: Array<Record<string, unknown>> = [];
  let settings: { workspaceId: string; allowShareLinks: boolean | null; allowPasswordlessShares: boolean | null } | null = null;
  const withDoc = (row: Record<string, unknown>) => ({ ...row, document: { title: docs.find((d) => d.id === row.documentId)!.title } });

  const prisma = {
    docs,
    shares,
    document: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const d = docs.find((x) => x.id === where.id);
        return d ? pick(d, select) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => docs.find((x) => x.id === where.id)!),
      findMany: vi.fn(async ({ where, take }: { where: { workspaceId: string; path: { startsWith: string }; id: { not: string } }; take: number }) =>
        docs
          .filter((d) => d.workspaceId === where.workspaceId && d.path.startsWith(where.path.startsWith) && d.id !== where.id.not && !d.archivedAt)
          .sort((a, b) => a.depth - b.depth || a.position - b.position)
          .slice(0, take),
      ),
    },
    documentRevision: { findUnique: vi.fn(async () => ({ finalizedAt: new Date('2026-10-01T00:00:00Z') })) },
    attachment: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => attachments.find((a) => a.id === where.id) ?? null) },
    publishingSettings: {
      findUnique: vi.fn(async () => settings),
      upsert: vi.fn(async ({ create, update }: { create: typeof settings; update: Partial<NonNullable<typeof settings>> }) => {
        settings = settings ? { ...settings, ...update } : create;
        return settings;
      }),
    },
    shareLink: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; tokenHash?: string } }) =>
        shares.find((s) => (where.id ? s.id === where.id : s.tokenHash === where.tokenHash)) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => withDoc(shares.find((s) => s.id === where.id)!)),
      findMany: vi.fn(async ({ where }: { where: { documentId?: string; workspaceId?: string; revokedAt?: null } }) =>
        shares
          .filter((s) => (where.documentId ? s.documentId === where.documentId : s.workspaceId === where.workspaceId))
          .filter((s) => (where.revokedAt === null ? s.revokedAt === null : true))
          .map(withDoc),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `share-${shares.length + 1}`, revokedAt: null, createdAt: new Date(), ...data };
        shares.push(row);
        return withDoc(row);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = shares.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return withDoc(row);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; revokedAt: null }; data: Record<string, unknown> }) => {
        const row = shares.find((s) => s.id === where.id && s.revokedAt === null);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }),
    },
  };
  return prisma;
}

/** Redis INCR/PEXPIRE/SET PX/GET, in memory. */
class FakeStore implements PublicKeyValueStore {
  readonly rows = new Map<string, string>();
  down = false;
  async incr(key: string) {
    if (this.down) throw new Error('redis down');
    const n = Number(this.rows.get(key) ?? 0) + 1;
    this.rows.set(key, String(n));
    return n;
  }
  async pexpire() {
    return 1;
  }
  async set(key: string, value: string) {
    if (this.down) throw new Error('redis down');
    this.rows.set(key, value);
    return 'OK';
  }
  async get(key: string) {
    if (this.down) throw new Error('redis down');
    return this.rows.get(key) ?? null;
  }
}

function env(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    PUBLIC_SHARING_ENABLED: true,
    SHARE_LINK_MAX_TTL_DAYS: 0,
    SHARE_UNLOCK_TTL_MIN: 60,
    PUBLIC_RATE_LIMIT_PER_MIN: 1000,
    PUBLIC_UNLOCK_ATTEMPTS_PER_15MIN: 3,
    SETTINGS_ENCRYPTION_KEY: KEY,
    WEB_BASE_URL: 'https://kb.example.com/',
    REDIS_URL: 'redis://unused',
    ...overrides,
  };
  return { get: (k: string) => values[k] };
}

function harness(envOverrides: Record<string, unknown> = {}) {
  const prisma = fakePrisma();
  const config = env(envOverrides);
  const activity = { record: vi.fn(async () => undefined) };
  const settings = new PublishingSettingsService(prisma as never, config as never);
  const shares = new ShareLinksService(prisma as never, settings, activity as never, config as never);
  const kv = new FakeStore();
  const store = new PublicStore(config as never, kv);
  const limiter = new PublicRateLimiter(store);
  const unlocks = new ShareUnlockService(store, config as never);
  const documents = {
    getContent: vi.fn(async (id: string) => ({
      documentId: id,
      revisionId: `rev-${id}`,
      contentType: 'text/markdown',
      frontmatter: { owner: 'alice' },
      markdown: `# body of ${id}`,
    })),
  };
  const attachments = { readUrl: vi.fn(async (doc: string, att: string) => `https://s3.example.com/${doc}/${att}`) };
  const reader = new PublicSharesService(
    prisma as never,
    settings,
    documents as never,
    attachments as never,
    unlocks,
    limiter,
    config as never,
  );
  return { prisma, settings, shares, reader, kv, store, limiter, unlocks, documents, attachments, activity, config };
}

const tokenOf = (url: string) => url.split('/s/')[1]!;
const req = (ip = '203.0.113.9') => ({ socket: { remoteAddress: ip }, headers: {} });

describe('share link policy helpers (contracts)', () => {
  it('a never-expiring link needs a password unless the workspace allows passwordless', () => {
    expect(shareNeedsPassword({ expiresAt: null, hasPassword: false }, { allowPasswordlessShares: false })).toBe(true);
    expect(shareNeedsPassword({ expiresAt: null, hasPassword: true }, { allowPasswordlessShares: false })).toBe(false);
    expect(shareNeedsPassword({ expiresAt: new Date(), hasPassword: false }, { allowPasswordlessShares: false })).toBe(false);
    expect(shareNeedsPassword({ expiresAt: null, hasPassword: false }, { allowPasswordlessShares: true })).toBe(false);
  });

  it('presets are relative to now; never is null', () => {
    const now = new Date('2026-10-12T00:00:00Z');
    expect(shareExpiryFor('7d', now)?.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(shareExpiryFor('never', now)).toBeNull();
  });

  it('files share.* activity under curate', () => {
    expect(activityKindFor('share.created')).toBe('curate');
  });
});

describe('ShareLinksService', () => {
  it('refuses to create while the workspace switch is off (the default), with share.disabledByWorkspace', async () => {
    const h = harness();
    const err = await h.shares.create(ROOT, { expiresAt: shareExpiryFor('7d')!.toISOString() }, USER).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ reason: 'share.disabledByWorkspace' });
  });

  it('treats PUBLIC_SHARING_ENABLED=false as a ceiling over a workspace that turned sharing on', async () => {
    const h = harness({ PUBLIC_SHARING_ENABLED: false });
    await h.settings.update(WS, { allowShareLinks: true });
    expect((await h.settings.get(WS)).effective.allowShareLinks).toBe(false);
    await expect(h.shares.create(ROOT, { password: 'secret1' }, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stores only the hash, keeps the link copyable under the key, and records the act', async () => {
    const h = harness();
    await h.settings.update(WS, { allowShareLinks: true });
    const res = await h.shares.create(ROOT, { password: 'secret1' }, USER);
    const token = tokenOf(res.url);
    expect(res.url).toMatch(/^https:\/\/kb\.example\.com\/s\/kp_[A-Za-z0-9_-]{43}$/);
    const row = h.prisma.shares[0]!;
    expect(row.tokenHash).toBe(shareTokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(res.share.url).toBe(res.url);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'share.created', documentId: ROOT, actor: USER }));
  });

  it('shows a link once when no SETTINGS_ENCRYPTION_KEY is set', async () => {
    const h = harness({ SETTINGS_ENCRYPTION_KEY: '' });
    await h.settings.update(WS, { allowShareLinks: true, allowPasswordlessShares: true });
    const res = await h.shares.create(ROOT, {}, USER);
    expect(res.url).toContain('/s/kp_');
    expect(res.share.url).toBeNull();
    expect((await h.shares.list(ROOT)).shares[0]!.url).toBeNull();
  });

  it('requires a password or an expiry unless passwordless is allowed, on create and on update', async () => {
    const h = harness();
    await h.settings.update(WS, { allowShareLinks: true });
    await expect(h.shares.create(ROOT, {}, USER)).rejects.toBeInstanceOf(BadRequestException);
    const res = await h.shares.create(ROOT, { password: 'secret1' }, USER);
    // Clearing the password on a never-expiring link would leave it open forever.
    await expect(h.shares.update(res.share.id, { password: null }, USER)).rejects.toBeInstanceOf(BadRequestException);
    const updated = await h.shares.update(res.share.id, { password: null, expiresAt: shareExpiryFor('1d')!.toISOString() }, USER);
    expect(updated.hasPassword).toBe(false);
    expect(updated.expiresAt).not.toBeNull();
  });

  it('clamps expiry to SHARE_LINK_MAX_TTL_DAYS and says what was asked for', async () => {
    const h = harness({ SHARE_LINK_MAX_TTL_DAYS: 7 });
    await h.settings.update(WS, { allowShareLinks: true });
    const asked = shareExpiryFor('30d')!.toISOString();
    const res = await h.shares.create(ROOT, { expiresAt: asked }, USER);
    expect(res.requestedExpiresAt).toBe(asked);
    expect(Date.parse(res.share.expiresAt!)).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    // "never" under a cap is the cap, so no password is demanded for it.
    const never = await h.shares.create(ROOT, { expiresAt: null }, USER);
    expect(never.share.expiresAt).not.toBeNull();
    await expect(h.shares.create(ROOT, { expiresAt: '2000-01-01T00:00:00Z' }, USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('revokes idempotently and keeps the row in the inventory', async () => {
    const h = harness();
    await h.settings.update(WS, { allowShareLinks: true });
    const res = await h.shares.create(ROOT, { password: 'secret1' }, USER);
    await h.shares.revoke(res.share.id, USER);
    await h.shares.revoke(res.share.id, USER);
    expect(h.activity.record.mock.calls.filter(([a]) => (a as { action: string }).action === 'share.revoked')).toHaveLength(1);
    expect((await h.shares.list(ROOT)).shares).toHaveLength(0);
    expect((await h.shares.listWorkspace(WS)).shares[0]!.revokedAt).not.toBeNull();
  });
});

describe('PublicSharesService (the anonymous reader)', () => {
  async function shared(input: Parameters<ShareLinksService['create']>[1], envOverrides: Record<string, unknown> = {}) {
    const h = harness(envOverrides);
    await h.settings.update(WS, { allowShareLinks: true, allowPasswordlessShares: true });
    const res = await h.shares.create(ROOT, input, USER);
    return { ...h, token: tokenOf(res.url), shareId: res.share.id };
  }

  it('serves the page without frontmatter, and nothing outside it', async () => {
    const h = await shared({});
    const view = await h.reader.view(h.token, undefined);
    expect(view).toMatchObject({ locked: false, rootDocumentId: ROOT, title: 'Guide', tree: [{ documentId: ROOT, parentId: null }] });
    const page = await h.reader.page(h.token, ROOT, undefined);
    expect(page).toEqual({ documentId: ROOT, title: 'Guide', markdown: `# body of ${ROOT}`, updatedAt: '2026-10-01T00:00:00.000Z' });
    expect(JSON.stringify(page)).not.toContain('alice');
    // Without includeSubtree even a child is out of scope.
    await expect(h.reader.page(h.token, CHILD, undefined)).rejects.toMatchObject({ status: 404 });
  });

  it('with includeSubtree reaches the subtree, and only the subtree of its own workspace', async () => {
    const h = await shared({ includeSubtree: true });
    const view = await h.reader.view(h.token, undefined);
    expect(view.locked === false && view.tree.map((n) => n.documentId)).toEqual([ROOT, CHILD]);
    await expect(h.reader.page(h.token, CHILD, undefined)).resolves.toMatchObject({ documentId: CHILD });
    for (const outside of [SIBLING, FOREIGN]) {
      await expect(h.reader.page(h.token, outside, undefined)).rejects.toMatchObject({ status: 404 });
      expect(h.documents.getContent).not.toHaveBeenCalledWith(outside);
    }
    // Archiving a page takes it out of the shared tree as well.
    h.prisma.docs.find((d) => d.id === CHILD)!.archivedAt = new Date();
    await expect(h.reader.page(h.token, CHILD, undefined)).rejects.toMatchObject({ status: 404 });
  });

  it('redirects to an attachment only when its page is in scope', async () => {
    const h = await shared({ includeSubtree: true });
    await expect(h.reader.attachmentUrl(h.token, ATT_CHILD, false, undefined)).resolves.toBe(`https://s3.example.com/${CHILD}/${ATT_CHILD}`);
    await expect(h.reader.attachmentUrl(h.token, ATT_SIBLING, false, undefined)).rejects.toMatchObject({ status: 404 });
    expect(h.attachments.readUrl).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown, malformed, revoked or expired link, and every link once sharing is switched off', async () => {
    const h = await shared({});
    await expect(h.reader.view('kp_' + 'x'.repeat(43), undefined)).rejects.toMatchObject({ status: 404 });
    await expect(h.reader.view('not-a-token', undefined)).rejects.toMatchObject({ status: 404 });

    h.prisma.shares[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(h.reader.view(h.token, undefined)).rejects.toMatchObject({ status: 404 });
    h.prisma.shares[0]!.expiresAt = null;
    await expect(h.reader.view(h.token, undefined)).resolves.toMatchObject({ locked: false });

    await h.settings.update(WS, { allowShareLinks: false });
    await expect(h.reader.view(h.token, undefined)).rejects.toMatchObject({ status: 404 });
    await h.settings.update(WS, { allowShareLinks: true });

    await h.shares.revoke(h.shareId, USER);
    await expect(h.reader.view(h.token, undefined)).rejects.toMatchObject({ status: 404 });
  });

  it('gates a password link; a session survives until the password changes', async () => {
    const h = await shared({ password: 'secret1' });
    expect(await h.reader.view(h.token, undefined)).toEqual({ locked: true });
    await expect(h.reader.page(h.token, ROOT, undefined)).rejects.toMatchObject({ status: 401 });
    await expect(h.reader.unlock(h.token, 'wrong-one', req())).rejects.toMatchObject({ status: 401 });

    const { session, shareId } = await h.reader.unlock(h.token, 'secret1', req());
    const cookie = `kn_lang=en; kn_share_${shareId}=${session}`;
    await expect(h.reader.view(h.token, cookie)).resolves.toMatchObject({ locked: false });
    await expect(h.reader.page(h.token, ROOT, cookie)).resolves.toMatchObject({ documentId: ROOT });
    // A session for one link opens no other.
    expect(await h.reader.view(h.token, `kn_share_other=${session}`)).toEqual({ locked: true });

    await h.shares.update(shareId, { password: 'another1' }, USER);
    expect(await h.reader.view(h.token, cookie)).toEqual({ locked: true });
  });

  it('rate-limits password guesses per address and link, and refuses them while the counter is down', async () => {
    const h = await shared({ password: 'secret1' });
    for (let i = 0; i < 3; i++) await expect(h.reader.unlock(h.token, 'nope-nope', req())).rejects.toMatchObject({ status: 401 });
    // Fourth attempt is refused before the password is compared — even the right one.
    await expect(h.reader.unlock(h.token, 'secret1', req())).rejects.toMatchObject({ status: 429 });
    // Another address has its own budget.
    await expect(h.reader.unlock(h.token, 'secret1', req('198.51.100.7'))).resolves.toMatchObject({ shareId: h.shareId });
    h.kv.down = true;
    await expect(h.reader.unlock(h.token, 'secret1', req('192.0.2.1'))).rejects.toMatchObject({ status: 429 });
  });
});

describe('clientIp', () => {
  it('believes X-Forwarded-For only from an internal peer', () => {
    expect(clientIp({ socket: { remoteAddress: '172.18.0.5' }, headers: { 'x-forwarded-for': '203.0.113.9, 172.18.0.2' } })).toBe('203.0.113.9');
    expect(clientIp({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } })).toBe('203.0.113.9');
    expect(clientIp({ socket: { remoteAddress: '198.51.100.7' }, headers: { 'x-forwarded-for': '203.0.113.9' } })).toBe('198.51.100.7');
    expect(clientIp({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': 'garbage' } })).toBe('10.0.0.1');
  });
});

describe('PublicSharesController over HTTP', () => {
  async function app(envOverrides: Record<string, unknown> = {}): Promise<{ app: INestApplication; token: string; h: ReturnType<typeof harness> }> {
    const h = harness(envOverrides);
    await h.settings.update(WS, { allowShareLinks: true });
    const { url } = await h.shares.create(ROOT, { password: 'secret1' }, USER);
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicSharesController],
      providers: [
        { provide: PublicSharesService, useValue: h.reader },
        { provide: PublicRateLimiter, useValue: h.limiter },
        { provide: ConfigService, useValue: h.config },
        PublicRateLimitGuard,
      ],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.useGlobalFilters(new ApiExceptionFilter());
    await nest.init();
    return { app: nest, token: tokenOf(url), h };
  }

  it('sends no-referrer, noindex and no-store on success and on a 404 alike', async () => {
    const { app: nest, token } = await app();
    for (const path of [`/v1/public/shares/${token}`, '/v1/public/shares/kp_unknown']) {
      const res = await request(nest.getHttpServer()).get(path);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect((await request(nest.getHttpServer()).get('/v1/public/shares/kp_unknown')).status).toBe(404);
    await nest.close();
  });

  it('unlocks into an httpOnly cookie the next read accepts', async () => {
    const { app: nest, token } = await app();
    const server = nest.getHttpServer();
    expect((await request(server).get(`/v1/public/shares/${token}`)).body).toEqual({ locked: true });
    expect((await request(server).post(`/v1/public/shares/${token}/unlock`).send({ password: 'bad-pass' })).status).toBe(401);
    const ok = await request(server).post(`/v1/public/shares/${token}/unlock`).send({ password: 'secret1' });
    expect(ok.status).toBe(204);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/^kn_share_[^=]+=[^;]+;.*HttpOnly/i);
    const view = await request(server).get(`/v1/public/shares/${token}`).set('Cookie', cookie.split(';')[0]!);
    expect(view.body).toMatchObject({ locked: false, title: 'Guide' });
    await nest.close();
  });

  it('caps anonymous reads per address with a 429 and Retry-After', async () => {
    const { app: nest, token } = await app({ PUBLIC_RATE_LIMIT_PER_MIN: 2 });
    const server = nest.getHttpServer();
    await request(server).get(`/v1/public/shares/${token}`);
    await request(server).get(`/v1/public/shares/${token}`);
    const third = await request(server).get(`/v1/public/shares/${token}`);
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBe('60');
    await nest.close();
  });
});
