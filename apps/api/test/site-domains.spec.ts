import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeHostname, siteRootUrl } from '@knowledge/contracts';
import { BUILD_STUCK_MS, PublishingSweeper, isDomainCheckDue } from '../src/publishing/publishing.sweeper.js';
import { SiteDomainsService } from '../src/publishing/site-domains.service.js';

/**
 * Custom domains and the publishing sweeper (docs/features/44, issue #77
 * phase 2b). What is pinned:
 * - a claim is a hostname in one canonical spelling, never the platform's own;
 * - control is proven by the TXT record and nothing else: a matching token
 *   verifies, a missing or different one does not, and DNS not answering is
 *   told apart from DNS answering "no";
 * - an unproven claim holds nothing against another site; a verified one does;
 * - the sweeper re-checks pending domains on a backoff and requeues builds
 *   that lost their job, claiming each with one guarded update.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE = '33333333-3333-4333-8333-333333333333';
const PROJECT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function env(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    SITE_CUSTOM_DOMAINS: true,
    PUBLISH_BASE_DOMAIN: 'docs.example.com',
    WEB_BASE_URL: 'https://kb.example.com',
    API_PUBLIC_URL: 'https://api.kb.example.com',
    PUBLISHING_SWEEP_INTERVAL_MS: 60_000,
    ...overrides,
  };
  return { get: (k: string) => values[k] };
}

type Row = {
  id: string;
  siteId: string;
  hostname: string;
  verifyToken: string;
  verifiedAt: Date | null;
  lastCheckAt: Date | null;
  lastError: string | null;
  createdBy: string;
  createdAt: Date;
};

function setup(opts: { env?: Record<string, unknown>; rows?: Partial<Row>[]; txt?: (name: string) => Promise<string[][]> } = {}) {
  const site = { id: SITE, workspaceId: WS, projectId: PROJECT, slug: 'acme', status: 'live' };
  const rows: Row[] = (opts.rows ?? []).map((r, i) => ({
    id: `d-${i}`,
    siteId: SITE,
    hostname: `h${i}.acme.com`,
    verifyToken: 'tok',
    verifiedAt: null,
    lastCheckAt: null,
    lastError: null,
    createdBy: WS,
    createdAt: new Date('2026-10-13T00:00:00Z'),
    ...r,
  }));
  const prisma = {
    rows,
    publishedSite: {
      findUnique: vi.fn(async () => ({ ...site, domains: rows.filter((r) => r.siteId === SITE) })),
    },
    siteDomain: {
      deleteMany: vi.fn(async ({ where }: { where: { hostname: string; verifiedAt: null; siteId: { not: string } } }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r.hostname === where.hostname && r.verifiedAt === null && r.siteId !== where.siteId.not) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
      create: vi.fn(async ({ data }: { data: Pick<Row, 'siteId' | 'hostname' | 'verifyToken' | 'createdBy'> }) => {
        if (rows.some((r) => r.hostname === data.hostname)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
        }
        const row: Row = { id: `d-${rows.length}`, verifiedAt: null, lastCheckAt: null, lastError: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const r = rows.find((x) => x.id === where.id);
        return r ? { ...r, ...(include ? { site } : {}) } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; verifiedAt: null }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id && x.verifiedAt === null);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      delete: vi.fn(),
    },
  };
  const activity = { record: vi.fn(async () => undefined) };
  const service = new SiteDomainsService(prisma as never, activity as never, env(opts.env) as never);
  const txt = opts.txt ?? (async () => [['knowledge-site-verification=tok']]);
  vi.spyOn(service as unknown as { resolveTxt: (n: string) => Promise<string[][]> }, 'resolveTxt').mockImplementation(txt);
  return { service, prisma, rows, activity };
}

const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe('normalizeHostname (contracts)', () => {
  it('reduces a typed or pasted name to one spelling, and refuses what is not a public DNS name', () => {
    expect(normalizeHostname(' https://Docs.Acme.com./guide?x=1 ')).toBe('docs.acme.com');
    expect(normalizeHostname('документы.рф')).toBe('xn--d1acoigc6ae0f.xn--p1ai');
    for (const bad of ['localhost', '10.0.0.1', 'docs.acme.com:8443', 'user@docs.acme.com', '-x.acme.com', 'a..b', '']) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });

  it('a verified domain becomes the site’s root URL', () => {
    expect(siteRootUrl('acme', { baseDomain: 'docs.example.com', webBaseUrl: 'https://kb.example.com', domain: 'docs.acme.com' })).toBe('https://docs.acme.com');
  });
});

describe('SiteDomainsService.add', () => {
  it('claims a hostname with a fresh token and tells the admin which records to create', async () => {
    const { service, activity } = setup();
    const d = await service.add(SITE, 'HTTPS://Docs.Acme.com/', WS);
    expect(d).toMatchObject({
      hostname: 'docs.acme.com',
      verified: false,
      txtName: '_knowledge.docs.acme.com',
      dnsTarget: 'acme.docs.example.com',
    });
    expect(d.txtValue).toMatch(/^knowledge-site-verification=[0-9a-f]{32}$/);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'site.domain.added' }));
  });

  it('refuses a non-hostname, and the platform’s own names', async () => {
    const { service } = setup();
    await expect(service.add(SITE, 'not a host', WS)).rejects.toBeInstanceOf(BadRequestException);
    for (const own of ['kb.example.com', 'api.kb.example.com', 'docs.example.com', 'other.docs.example.com', 'app.localhost']) {
      await expect(service.add(SITE, own, WS)).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'site.domainReserved' }) });
    }
  });

  it('refuses a duplicate on the same site, and past the limit', async () => {
    const dup = setup({ rows: [{ hostname: 'docs.acme.com' }] });
    await expect(dup.service.add(SITE, 'docs.acme.com', WS)).rejects.toBeInstanceOf(ConflictException);
    const full = setup({ rows: [{}, {}, {}, {}, {}] });
    await expect(full.service.add(SITE, 'six.acme.com', WS)).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'site.domainLimit' }) });
  });

  it('takes over another site’s unproven claim, but not a verified one', async () => {
    const pending = setup({ rows: [{ siteId: OTHER_SITE, hostname: 'docs.acme.com' }] });
    expect((await pending.service.add(SITE, 'docs.acme.com', WS)).hostname).toBe('docs.acme.com');
    expect(pending.rows.filter((r) => r.hostname === 'docs.acme.com').map((r) => r.siteId)).toEqual([SITE]);

    const verified = setup({ rows: [{ siteId: OTHER_SITE, hostname: 'docs.acme.com', verifiedAt: new Date() }] });
    await expect(verified.service.add(SITE, 'docs.acme.com', WS)).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'site.domainTaken' }) });
  });

  it('is refused outright while SITE_CUSTOM_DOMAINS is off', async () => {
    const { service } = setup({ env: { SITE_CUSTOM_DOMAINS: false } });
    await expect(service.add(SITE, 'docs.acme.com', WS)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('SiteDomainsService TXT check', () => {
  it('verifies on a matching token, also when DNS split the value into strings', async () => {
    const { service } = setup({ txt: async () => [['v=spf1 -all'], ['knowledge-site-verification=', 'tok']] });
    expect(await service.lookup('docs.acme.com', 'tok')).toEqual({ ok: true });
  });

  it('tells a missing record, a different token and DNS not answering apart', async () => {
    expect(await setup({ txt: async () => [['v=spf1 -all']] }).service.lookup('d.acme.com', 'tok')).toEqual({ ok: false, error: 'txtMissing' });
    expect(await setup({ txt: async () => [['knowledge-site-verification=old']] }).service.lookup('d.acme.com', 'tok')).toEqual({ ok: false, error: 'txtMismatch' });
    expect(await setup({ txt: async () => Promise.reject(dnsError('ENOTFOUND')) }).service.lookup('d.acme.com', 'tok')).toEqual({ ok: false, error: 'txtMissing' });
    expect(await setup({ txt: async () => Promise.reject(dnsError('ETIMEOUT')) }).service.lookup('d.acme.com', 'tok')).toEqual({ ok: false, error: 'dnsError' });
  });

  it('asks for the record under _knowledge.<hostname>', async () => {
    const txt = vi.fn(async () => [['knowledge-site-verification=tok']]);
    await setup({ txt }).service.lookup('docs.acme.com', 'tok');
    expect(txt).toHaveBeenCalledWith('_knowledge.docs.acme.com');
  });

  it('Verify stores the outcome either way, and records the act once', async () => {
    const failing = setup({ rows: [{}], txt: async () => [] });
    const d = await failing.service.verify('d-0', WS);
    expect(d).toMatchObject({ verified: false, lastError: 'txtMissing' });
    expect(d.lastCheckAt).not.toBeNull();

    const passing = setup({ rows: [{}] });
    expect(await passing.service.verify('d-0', WS)).toMatchObject({ verified: true, lastError: null });
    await passing.service.verify('d-0', WS); // already verified: no second lookup, no second record
    expect(passing.activity.record.mock.calls.filter((c) => (c as unknown[] as [{ action: string }])[0].action === 'site.domain.verified')).toHaveLength(1);
  });

  it('never re-checks a verified domain, so deleting the TXT record later does not take a site down', async () => {
    const txt = vi.fn(async () => []);
    const { service, rows } = setup({ rows: [{ verifiedAt: new Date('2026-10-01T00:00:00Z') }], txt });
    await service.check({ ...rows[0], site: {} as never });
    expect(txt).not.toHaveBeenCalled();
    expect(rows[0].verifiedAt).not.toBeNull();
  });
});

describe('PublishingSweeper', () => {
  const NOW = new Date('2026-10-13T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const MIN = 60_000;

  it('checks a pending domain every few minutes on its first day, hourly after, and gives up after a week', () => {
    expect(isDomainCheckDue({ createdAt: ago(10 * MIN), lastCheckAt: null, verifiedAt: null }, NOW)).toBe(true);
    expect(isDomainCheckDue({ createdAt: ago(10 * MIN), lastCheckAt: ago(2 * MIN), verifiedAt: null }, NOW)).toBe(false);
    expect(isDomainCheckDue({ createdAt: ago(10 * MIN), lastCheckAt: ago(6 * MIN), verifiedAt: null }, NOW)).toBe(true);
    expect(isDomainCheckDue({ createdAt: ago(2 * 1440 * MIN), lastCheckAt: ago(30 * MIN), verifiedAt: null }, NOW)).toBe(false);
    expect(isDomainCheckDue({ createdAt: ago(2 * 1440 * MIN), lastCheckAt: ago(61 * MIN), verifiedAt: null }, NOW)).toBe(true);
    expect(isDomainCheckDue({ createdAt: ago(8 * 1440 * MIN), lastCheckAt: ago(1440 * MIN), verifiedAt: null }, NOW)).toBe(false);
    expect(isDomainCheckDue({ createdAt: ago(10 * MIN), lastCheckAt: null, verifiedAt: NOW }, NOW)).toBe(false);
  });

  function sweeper(opts: { env?: Record<string, unknown>; domains?: unknown[]; versions?: { id: string; status: string; updatedAt: Date }[] } = {}) {
    const versions = opts.versions ?? [];
    const prisma = {
      siteDomain: { findMany: vi.fn(async () => opts.domains ?? []) },
      siteVersion: {
        findMany: vi.fn(async ({ where }: { where: { updatedAt: { lt: Date } } }) =>
          versions.filter((v) => v.status === 'building' && v.updatedAt < where.updatedAt.lt).map(({ id }) => ({ id })),
        ),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; updatedAt: { lt: Date } }; data: { updatedAt: Date } }) => {
          const v = versions.find((x) => x.id === where.id && x.status === 'building' && x.updatedAt < where.updatedAt.lt);
          if (!v) return { count: 0 };
          v.updatedAt = data.updatedAt;
          return { count: 1 };
        }),
      },
    };
    const domains = { check: vi.fn(async () => undefined) };
    const builds = { enqueue: vi.fn(async () => undefined) };
    const s = new PublishingSweeper(prisma as never, domains as never, builds as never, env(opts.env) as never);
    return { s, prisma, domains, builds };
  }

  it('checks only the pending domains that are due', async () => {
    const due = { id: 'a', createdAt: ago(10 * MIN), lastCheckAt: null, verifiedAt: null };
    const notYet = { id: 'b', createdAt: ago(2 * 1440 * MIN), lastCheckAt: ago(10 * MIN), verifiedAt: null };
    const { s, domains } = sweeper({ domains: [due, notYet] });
    expect((await s.sweep(NOW)).domainsChecked).toBe(1);
    expect(domains.check).toHaveBeenCalledWith(due);
  });

  it('checks no domains while SITE_CUSTOM_DOMAINS is off', async () => {
    const { s, prisma } = sweeper({ env: { SITE_CUSTOM_DOMAINS: false }, domains: [{ id: 'a', createdAt: NOW, lastCheckAt: null, verifiedAt: null }] });
    expect((await s.sweep(NOW)).domainsChecked).toBe(0);
    expect(prisma.siteDomain.findMany).not.toHaveBeenCalled();
  });

  it('requeues a build that has said `building` too long, once, and leaves a running one alone', async () => {
    const lost = { id: 'lost', status: 'building', updatedAt: ago(BUILD_STUCK_MS + MIN) };
    const running = { id: 'running', status: 'building', updatedAt: ago(MIN) };
    const { s, builds } = sweeper({ versions: [lost, running] });
    expect((await s.sweep(NOW)).buildsRequeued).toBe(1);
    expect(builds.enqueue).toHaveBeenCalledWith('lost', { now: true });
    // The claim restarted its clock: the next tick does not requeue it again.
    expect((await s.sweep(new Date(NOW.getTime() + MIN))).buildsRequeued).toBe(0);
  });

  it('does not stack a sweep on one still running', async () => {
    const { s, prisma } = sweeper();
    let release!: () => void;
    prisma.siteDomain.findMany.mockImplementationOnce(() => new Promise((r) => (release = () => r([]))));
    const first = s.sweep(NOW);
    expect(await s.sweep(NOW)).toEqual({ domainsChecked: 0, buildsRequeued: 0 });
    release();
    await first;
    expect(prisma.siteDomain.findMany).toHaveBeenCalledTimes(1);
  });
});
