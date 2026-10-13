import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  isValidSiteSlug,
  normalizeSiteTheme,
  siteRootUrl,
  sitePagePath,
  siteThemeErrors,
  suggestSiteSlug,
} from '@knowledge/contracts';
import { PublishingSettingsService } from '../src/publishing/publishing-settings.service.js';
import { SitesService } from '../src/publishing/sites.service.js';
import { PublicSitesService } from '../src/public/public-sites.service.js';
import { PublicSiteFilesService } from '../src/public/public-site-files.service.js';

/**
 * Published sites, read and managed (docs/features/44, issue #77 phase 2a).
 * What is pinned:
 * - the switches: a site resolves only while it is live, its workspace allows
 *   sites and PUBLIC_SITES_ENABLED is on; anything else is a 404;
 * - the snapshot: a page is read at the revision its version pinned, so a
 *   frozen version ignores everything merged since; a path outside the
 *   snapshot and an attachment of a page outside it are 404s;
 * - paths: version segments, the home page, and a version switch that keeps
 *   the reader on the same page;
 * - management: create needs the switch, slugs are checked, a version may not
 *   shadow a top-level page, and the default version cannot be deleted;
 * - audiences (phase 3): a page kept from the reader is absent everywhere —
 *   tree, path, alternates, attachments, sitemap, llms.txt, `.md` — as a 404,
 *   never a 403, and the ETags move when a restamp changes who sees what.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const V_LATEST = '33333333-3333-4333-8333-333333333333';
const V_OLD = '44444444-4444-4444-8444-444444444444';
const V_UNBUILT = '55555555-5555-4555-8555-555555555555';
const DOC_HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_INSTALL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOC_SECRET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ATT_INSTALL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ATT_SECRET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PROJECT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** Enough of Prisma's `where` for these fakes: equality, `{ in }`, `{ not: null }` and `null`. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in) return c.in.includes(v);
      if ('not' in c) return c.not === null ? v !== null && v !== undefined : v !== c.not;
    }
    return v === cond;
  });
}

function fakePrisma() {
  const built = new Date('2026-10-12T00:00:00Z');
  const site = {
    id: SITE,
    workspaceId: WS,
    projectId: PROJECT,
    slug: 'acme',
    status: 'live',
    rootDocumentId: null as string | null,
    theme: { primaryColor: '#123456', font: 'serif', headerLinks: [{ label: 'x', url: 'javascript:alert(1)' }] },
    seoIndexable: true,
    defaultVersionId: V_LATEST,
    createdAt: built,
    updatedAt: built,
  };
  const versions = [
    { id: V_LATEST, siteId: SITE, name: 'Latest', slug: 'latest', kind: 'live', builtAt: built, createdAt: new Date(1) },
    { id: V_OLD, siteId: SITE, name: 'v1', slug: 'v1', kind: 'frozen', builtAt: built, createdAt: new Date(2) },
    { id: V_UNBUILT, siteId: SITE, name: 'next', slug: 'next', kind: 'live', builtAt: null, createdAt: new Date(3) },
  ];
  const pages: Array<{
    versionId: string;
    documentId: string;
    revisionId: string;
    parentId: string | null;
    position: number;
    depth: number;
    slugPath: string;
    title: string;
    audience: string;
    audienceClaims: unknown;
  }> = [
    { versionId: V_LATEST, documentId: DOC_HOME, revisionId: 'home-r3', parentId: null, position: 0, depth: 0, slugPath: 'welcome', title: 'Welcome', audience: 'public', audienceClaims: null },
    { versionId: V_LATEST, documentId: DOC_INSTALL, revisionId: 'install-r5', parentId: DOC_HOME, position: 0, depth: 1, slugPath: 'welcome/install', title: 'Install', audience: 'public', audienceClaims: null },
    // The frozen version pinned older revisions, and had no install page yet.
    { versionId: V_OLD, documentId: DOC_HOME, revisionId: 'home-r1', parentId: null, position: 0, depth: 0, slugPath: 'welcome', title: 'Welcome', audience: 'public', audienceClaims: null },
  ];
  const domains = [
    { id: 'd-1', siteId: SITE, hostname: 'docs.acme.com', verifiedAt: new Date('2026-10-13T00:00:00Z') as Date | null },
    { id: 'd-2', siteId: SITE, hostname: 'pending.acme.com', verifiedAt: null as Date | null },
  ];
  let settings: { allowPublicSites: boolean | null } | null = { allowPublicSites: true };
  const prisma = {
    site,
    versions,
    pages,
    domains,
    setSettings: (v: typeof settings) => (settings = v),
    publishingSettings: { findUnique: vi.fn(async () => settings) },
    publishedSite: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        const hit = where.slug ? site.slug === where.slug : site.id === where.id;
        if (!hit) return null;
        return {
          ...site,
          versions: versions.filter((v) => v.builtAt !== null),
          domains: domains.filter((d) => d.verifiedAt !== null),
        };
      }),
    },
    siteDomain: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const d = domains.find((row) => matches(row, where));
        return d ? { ...d, site: { workspaceId: site.workspaceId } } : null;
      }),
    },
    siteVersionPage: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pages.filter((p) => matches(p, where))),
      findUnique: vi.fn(async ({ where }: { where: { versionId_documentId: { versionId: string; documentId: string } } }) =>
        pages.find((p) => p.versionId === where.versionId_documentId.versionId && p.documentId === where.versionId_documentId.documentId) ?? null,
      ),
    },
    project: {
      findUnique: vi.fn(async () => ({ name: 'Acme Docs', avatarKey: 'k', avatarEmoji: null, avatarColor: null, avatarUpdatedAt: new Date(5) })),
    },
    documentRevision: {
      findUnique: vi.fn(async () => ({ finalizedAt: built })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, finalizedAt: built }))),
    },
    attachment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        ({ [ATT_INSTALL]: { id: ATT_INSTALL, documentId: DOC_INSTALL, status: 'ready' }, [ATT_SECRET]: { id: ATT_SECRET, documentId: DOC_SECRET, status: 'ready' } })[where.id] ?? null,
      ),
    },
  };
  return prisma;
}

function env(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    PUBLIC_SHARING_ENABLED: true,
    PUBLIC_SITES_ENABLED: true,
    SHARE_LINK_MAX_TTL_DAYS: 0,
    PUBLISH_BASE_DOMAIN: 'docs.example.com',
    WEB_BASE_URL: 'https://kb.example.com',
    SITE_CUSTOM_DOMAINS: true,
    LLMS_FULL_MAX_DOCS: 2000,
    LLMS_FULL_MAX_BYTES: 20_000_000,
    ...overrides,
  };
  return { get: (k: string) => values[k] };
}

function reader(envOverrides: Record<string, unknown> = {}) {
  const prisma = fakePrisma();
  const config = env(envOverrides);
  const settings = new PublishingSettingsService(prisma as never, config as never);
  const documents = {
    getContent: vi.fn(async (documentId: string, revisionId: string) => ({ documentId, revisionId, markdown: `body of ${revisionId}` })),
  };
  const attachments = { readUrl: vi.fn(async (doc: string, att: string) => `https://s3/${doc}/${att}`) };
  const avatars = { presignedGet: vi.fn(async () => 'https://s3/avatar') };
  const sessions = { viewer: vi.fn(async () => ({ kind: 'anonymous' })) };
  const service = new PublicSitesService(
    prisma as never,
    settings,
    documents as never,
    attachments as never,
    avatars as never,
    config as never,
    sessions as never,
  );
  return { prisma, service, documents, attachments, sessions };
}

describe('site helpers (contracts)', () => {
  it('slugs are DNS labels, and the platform’s own names are reserved', () => {
    expect(isValidSiteSlug('acme-docs')).toBe(true);
    for (const bad of ['a', '-acme', 'acme-', 'ac--me', 'Acme', 'acme.docs', 'api', 'www']) expect(isValidSiteSlug(bad)).toBe(false);
    expect(suggestSiteSlug('Документация OMS 2.0')).toBe('dokumentatsiya-oms-2-0');
  });

  it('a site URL is a subdomain with a base domain, path mode without', () => {
    expect(siteRootUrl('acme', { baseDomain: 'docs.example.com', webBaseUrl: 'https://kb.example.com/' })).toBe('https://acme.docs.example.com');
    expect(siteRootUrl('acme', { baseDomain: '', webBaseUrl: 'https://kb.example.com/' })).toBe('https://kb.example.com/pub/acme');
    expect(sitePagePath('/pub/acme', 'v1', 'guides/установка')).toBe('/pub/acme/v1/guides/%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%BA%D0%B0');
    expect(sitePagePath('', null, '')).toBe('/');
  });

  it('a theme is values only: bad colours, fonts and non-http links are refused on write and dropped on read', () => {
    expect(siteThemeErrors({ primaryColor: 'red', font: 'comic' as never, headerLinks: [{ label: 'x', url: 'javascript:alert(1)' }] })).toEqual([
      'primaryColor',
      'font',
      'headerLinks',
    ]);
    const theme = normalizeSiteTheme({ primaryColor: '#ABCDEF', font: 'comic', headerLinks: [{ label: 'x', url: 'javascript:alert(1)' }], extra: 1 });
    expect(theme).toEqual({ primaryColor: '#abcdef', primaryColorDark: null, font: 'system', showLogo: true, headerLinks: [], footerText: null });
  });
});

describe('PublicSitesService.resolve', () => {
  it('serves the home page at the root, the default version, and a normalized theme', async () => {
    const { service } = reader();
    const res = await service.resolve({ slug: 'acme', path: '/' });
    expect(res.page).toMatchObject({ documentId: DOC_HOME, slugPath: 'welcome', markdown: 'body of home-r3' });
    expect(res.version).toMatchObject({ slug: 'latest', isDefault: true });
    // The first verified custom domain is the canonical root.
    expect(res.site).toMatchObject({ title: 'Acme Docs', rootUrl: 'https://docs.acme.com' });
    expect(res.site.theme.headerLinks).toEqual([]);
    expect(res.site.logo).toEqual({ kind: 'image', url: `/v1/public/sites/${SITE}/logo?v=5` });
  });

  it('lists only versions that have built, default first', async () => {
    const { service } = reader();
    const res = await service.resolve({ slug: 'acme', path: '/' });
    expect(res.versions.map((v) => v.slug)).toEqual(['latest', 'v1']);
  });

  it('reads a frozen version at the revisions it pinned, whatever has been merged since', async () => {
    const { service, documents } = reader();
    const res = await service.resolve({ slug: 'acme', path: '/v1/welcome' });
    expect(res.version.slug).toBe('v1');
    expect(documents.getContent).toHaveBeenCalledWith(DOC_HOME, 'home-r1');
    expect(res.page?.markdown).toBe('body of home-r1');
  });

  it('answers a path the snapshot does not have with no page (a 404 in the site’s chrome)', async () => {
    const { service } = reader();
    expect((await service.resolve({ slug: 'acme', path: '/v1/welcome/install' })).page).toBeNull();
    expect((await service.resolve({ slug: 'acme', path: `/${DOC_SECRET}` })).page).toBeNull();
  });

  it('switching versions keeps the page when the target has it, and lands on its home when not', async () => {
    const { service } = reader();
    const kept = await service.resolve({ slug: 'acme', path: '/v1/renamed-meanwhile', from: DOC_HOME });
    expect(kept.page?.documentId).toBe(DOC_HOME);
    const home = await service.resolve({ slug: 'acme', path: '/v1/welcome/install', from: DOC_INSTALL });
    expect(home.page?.documentId).toBe(DOC_HOME);
  });

  it('resolves a site by its own host under PUBLISH_BASE_DOMAIN, and no deeper or bare base host', async () => {
    const { service } = reader();
    expect((await service.resolve({ host: 'ACME.docs.example.com:443', path: '/' })).site.slug).toBe('acme');
    expect(service.siteKeyFromHost('a.b.docs.example.com')).toBeNull();
    expect(service.siteKeyFromHost('docs.example.com')).toBeNull();
    expect(reader({ PUBLISH_BASE_DOMAIN: '' }).service.siteKeyFromHost('acme.docs.example.com')).toEqual({ hostname: 'acme.docs.example.com' });
  });

  it('resolves a verified custom domain, and 404s a pending one or any domain while SITE_CUSTOM_DOMAINS is off', async () => {
    const { service } = reader();
    expect((await service.resolve({ host: 'Docs.Acme.com.', path: '/' })).site.slug).toBe('acme');
    await expect(service.resolve({ host: 'pending.acme.com', path: '/' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resolve({ host: 'acme.evil.com', path: '/' })).rejects.toBeInstanceOf(NotFoundException);

    const off = reader({ SITE_CUSTOM_DOMAINS: false });
    await expect(off.service.resolve({ host: 'docs.acme.com', path: '/' })).rejects.toBeInstanceOf(NotFoundException);
    // …and its canonical root falls back to the subdomain.
    expect((await off.service.resolve({ slug: 'acme', path: '/' })).site.rootUrl).toBe('https://acme.docs.example.com');
  });

  it('names the same page in the other built versions, the home at its version root', async () => {
    const { service } = reader();
    const latest = await service.resolve({ slug: 'acme', path: '/' });
    expect(latest.page?.alternates).toEqual([{ version: { slug: 'v1', name: 'v1', isDefault: false }, path: '/v1' }]);
    const install = await service.resolve({ slug: 'acme', path: '/welcome/install' });
    expect(install.page?.alternates).toEqual([]); // v1 had no install page
    const old = await service.resolve({ slug: 'acme', path: '/v1/welcome' });
    expect(old.page?.alternates).toEqual([{ version: { slug: 'latest', name: 'Latest', isDefault: true }, path: '/' }]);
  });

  it('404s a site that is not live, switched off by its workspace, or above the ceiling', async () => {
    const draft = reader();
    draft.prisma.site.status = 'draft';
    await expect(draft.service.resolve({ slug: 'acme' })).rejects.toBeInstanceOf(NotFoundException);

    const off = reader();
    off.prisma.setSettings(null); // an empty table reproduces "nothing is public"
    await expect(off.service.resolve({ slug: 'acme' })).rejects.toBeInstanceOf(NotFoundException);

    const ceiling = reader({ PUBLIC_SITES_ENABLED: false });
    await expect(ceiling.service.resolve({ slug: 'acme' })).rejects.toBeInstanceOf(NotFoundException);

    await expect(reader().service.resolve({ slug: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s a site whose default version has never built', async () => {
    const { service, prisma } = reader();
    prisma.site.defaultVersionId = V_UNBUILT;
    await expect(service.resolve({ slug: 'acme' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PublicSitesService.attachmentUrl', () => {
  it('serves an attachment of a page in the version’s snapshot', async () => {
    const { service } = reader();
    expect(await service.attachmentUrl(SITE, V_LATEST, ATT_INSTALL, false)).toBe(`https://s3/${DOC_INSTALL}/${ATT_INSTALL}`);
  });

  it('404s an attachment of a page outside the snapshot, or of a version that lacks the page', async () => {
    const { service } = reader();
    await expect(service.attachmentUrl(SITE, V_LATEST, ATT_SECRET, false)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.attachmentUrl(SITE, V_OLD, ATT_INSTALL, false)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.attachmentUrl(SITE, V_UNBUILT, ATT_INSTALL, false)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------

function manager(opts: { enabled?: boolean } = {}) {
  const site = {
    id: SITE,
    workspaceId: WS,
    projectId: PROJECT,
    slug: 'acme',
    status: 'draft',
    rootDocumentId: null,
    theme: {},
    seoIndexable: true,
    defaultVersionId: V_LATEST,
    createdAt: new Date(),
    updatedAt: new Date(),
    versions: [{ id: V_LATEST, siteId: SITE, name: 'Latest', slug: 'latest', kind: 'live', sourceBranch: null, status: 'ready', builtAt: new Date(), pageCount: 1, warnings: [], error: null, createdBy: WS, createdAt: new Date() }],
    domains: [] as unknown[],
  };
  const prisma = {
    publishingSettings: { findUnique: vi.fn(async () => ({ allowPublicSites: opts.enabled ?? true })) },
    project: { findUnique: vi.fn(async () => ({ id: PROJECT, workspaceId: WS, site: null })) },
    publishedSite: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; slug?: string } }) =>
        where.slug ? (where.slug === 'taken' ? { id: 'other' } : null) : site,
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(site, data)),
    },
    siteVersion: {
      findUnique: vi.fn(async () => ({ ...site.versions[0], site })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...site.versions[0], ...data })),
      create: vi.fn(),
      delete: vi.fn(),
    },
    siteVersionPage: {
      findFirst: vi.fn(async ({ where }: { where: { slugPath: string } }) => (where.slugPath === 'guides' ? { documentId: DOC_HOME } : null)),
    },
    document: { findUnique: vi.fn(async () => ({ projectId: 'another-project', archivedAt: null })) },
  };
  const config = env();
  const settings = new PublishingSettingsService(prisma as never, config as never);
  const builds = { enqueue: vi.fn(async () => undefined) };
  const activity = { record: vi.fn(async () => undefined) };
  return { prisma, site, builds, service: new SitesService(prisma as never, settings, activity as never, builds as never, config as never) };
}

describe('SitesService', () => {
  it('refuses to create while sites are off, with site.disabledByWorkspace', async () => {
    const err = await manager({ enabled: false }).service.create(PROJECT, { slug: 'acme' }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ reason: 'site.disabledByWorkspace' });
  });

  it('checks the slug: reserved, malformed and taken are refused before anything is written', async () => {
    const { service } = manager();
    await expect(service.create(PROJECT, { slug: 'api' })).rejects.toMatchObject({ response: { reason: 'site.slugReserved' } });
    await expect(service.create(PROJECT, { slug: 'Bad Slug' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(PROJECT, { slug: 'taken' })).rejects.toMatchObject({ response: { reason: 'site.slugTaken' } });
  });

  it('refuses a root page from another project', async () => {
    const { service } = manager();
    await expect(service.create(PROJECT, { slug: 'fresh', rootDocumentId: DOC_HOME })).rejects.toMatchObject({
      response: { reason: 'site.rootNotInProject' },
    });
  });

  it('refuses to publish while sites are off, even an existing draft', async () => {
    await expect(manager({ enabled: false }).service.publish(SITE)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an invalid theme, naming the fields', async () => {
    const err = await manager().service.update(SITE, { theme: { primaryColor: 'blue' } }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ fields: ['primaryColor'] });
  });

  it('refuses a version address that a top-level page already uses, rather than shadowing it', async () => {
    const { service, prisma } = manager();
    await expect(service.createVersion(SITE, { name: 'Guides', kind: 'frozen' })).rejects.toMatchObject({
      response: { reason: 'site.versionSlugShadowsPage' },
    });
    expect(prisma.siteVersion.create).not.toHaveBeenCalled();
  });

  it('will not delete the default version', async () => {
    const { service, prisma } = manager();
    await expect(service.deleteVersion(V_LATEST)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.siteVersion.delete).not.toHaveBeenCalled();
  });

  it('a rebuild asked for by a person skips the debounce', async () => {
    const { service, builds } = manager();
    await service.rebuild(V_LATEST, WS);
    expect(builds.enqueue).toHaveBeenCalledWith(V_LATEST, { now: true });
  });
});

// ---------------------------------------------------------------------------
// Phase 2b: the TLS ask, and the machine-readable files

describe('PublicSitesService.hostAllowed (Caddy on-demand TLS ask)', () => {
  it('allows a site’s subdomain and its verified domains, and nothing else', async () => {
    const { service } = reader();
    expect(await service.hostAllowed('acme.docs.example.com')).toBe(true);
    expect(await service.hostAllowed('docs.acme.com')).toBe(true);
    expect(await service.hostAllowed('pending.acme.com')).toBe(false); // unproven: no certificate
    expect(await service.hostAllowed('nope.docs.example.com')).toBe(false);
    expect(await service.hostAllowed('docs.example.com')).toBe(false);
    expect(await service.hostAllowed('random.example.org')).toBe(false);
    expect(await service.hostAllowed('not a host')).toBe(false);
  });

  it('allows nothing while the workspace switch or custom domains are off', async () => {
    const off = reader();
    off.prisma.setSettings({ allowPublicSites: false });
    expect(await off.service.hostAllowed('acme.docs.example.com')).toBe(false);
    expect(await off.service.hostAllowed('docs.acme.com')).toBe(false);
    expect(await reader({ SITE_CUSTOM_DOMAINS: false }).service.hostAllowed('docs.acme.com')).toBe(false);
  });
});

function files(envOverrides: Record<string, unknown> = {}) {
  const r = reader(envOverrides);
  const config = env(envOverrides);
  const service = new PublicSiteFilesService(r.service, r.prisma as never, r.documents as never, config as never);
  return { ...r, files: service };
}

describe('PublicSiteFilesService', () => {
  it('sitemap.xml lists the default version’s pages at their one canonical URL', async () => {
    const { files: f } = files();
    const map = await f.sitemap({ slug: 'acme' });
    expect(map.body).toContain('<loc>https://docs.acme.com/</loc>'); // the home lives at the root
    expect(map.body).toContain('<loc>https://docs.acme.com/welcome/install</loc>');
    expect(map.body).not.toContain('/v1');
    expect(map.body).toContain('<lastmod>2026-10-12T00:00:00.000Z</lastmod>');
  });

  it('a site that asked not to be indexed has no sitemap, and robots.txt disallows everything', async () => {
    const { files: f, prisma } = files();
    expect((await f.robots({ slug: 'acme' })).body).toBe('User-agent: *\nAllow: /\n\nSitemap: https://docs.acme.com/sitemap.xml\n');
    prisma.site.seoIndexable = false;
    await expect(f.sitemap({ slug: 'acme' })).rejects.toBeInstanceOf(NotFoundException);
    expect((await f.robots({ slug: 'acme' })).body).toBe('User-agent: *\nDisallow: /\n');
  });

  it('answers 304 when the snapshot has not changed, and a new ETag after a build', async () => {
    const { files: f, prisma } = files();
    const first = await f.sitemap({ slug: 'acme' });
    expect((await f.sitemap({ slug: 'acme' }, first.etag)).body).toBeNull();
    prisma.versions[0].builtAt = new Date('2026-10-14T00:00:00Z');
    const rebuilt = await f.sitemap({ slug: 'acme' }, first.etag);
    expect(rebuilt.body).not.toBeNull();
    expect(rebuilt.etag).not.toBe(first.etag);
  });

  it('llms.txt links only the version’s published pages, as markdown, then the other versions', async () => {
    const { files: f } = files();
    const index = (await f.llmsIndex({ slug: 'acme' })).body!;
    expect(index).toContain('# Acme Docs');
    expect(index).toContain('Full text: https://docs.acme.com/llms-full.txt');
    expect(index).toContain('- [Welcome](https://docs.acme.com/welcome.md)\n  - [Install](https://docs.acme.com/welcome/install.md)');
    expect(index).toContain('## Other versions\n\n- [v1](https://docs.acme.com/v1/llms.txt)');
    expect(index).not.toContain(DOC_SECRET);

    const old = (await f.llmsIndex({ slug: 'acme', version: 'v1' })).body!;
    expect(old).toContain('- [Welcome](https://docs.acme.com/v1/welcome.md)');
    expect(old).not.toContain('Install');
    await expect(f.llmsIndex({ slug: 'acme', version: 'next' })).rejects.toBeInstanceOf(NotFoundException); // never built
  });

  it('llms-full.txt is every page at its pinned revision, and stops at the caps', async () => {
    const { files: f } = files();
    const out: string[] = [];
    await f.streamFull(await f.llmsFullPlan({ slug: 'acme', version: 'v1' }), { write: (c) => out.push(c) });
    const text = out.join('');
    expect(text).toContain('Source: https://docs.acme.com/v1');
    expect(text).toContain('body of home-r1');
    expect(text).not.toContain('home-r3');

    const capped = files({ LLMS_FULL_MAX_DOCS: 1 });
    const out2: string[] = [];
    await capped.files.streamFull(await capped.files.llmsFullPlan({ slug: 'acme' }), { write: (c) => out2.push(c) });
    expect(out2.join('')).toContain('<!-- truncated: 1 more page -->');
  });

  it('a page as markdown: by its path, the home as index, and 404 outside the snapshot', async () => {
    const { files: f, documents } = files();
    expect((await f.markdown({ slug: 'acme', path: 'welcome/install' })).body).toBe('# Install\n\nbody of install-r5\n');
    expect((await f.markdown({ slug: 'acme', path: 'index' })).body).toBe('# Welcome\n\nbody of home-r3\n');
    expect((await f.markdown({ slug: 'acme', path: 'v1/welcome' })).body).toBe('# Welcome\n\nbody of home-r1\n');
    await expect(f.markdown({ slug: 'acme', path: 'v1/welcome/install' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.markdown({ slug: 'acme', path: DOC_SECRET })).rejects.toBeInstanceOf(NotFoundException);
    expect(documents.getContent).not.toHaveBeenCalledWith(DOC_SECRET, expect.anything());
  });

  it('every file is a 404 for a site that is not live', async () => {
    const { files: f, prisma } = files();
    prisma.site.status = 'unpublished';
    for (const call of [() => f.sitemap({ slug: 'acme' }), () => f.robots({ slug: 'acme' }), () => f.llmsIndex({ slug: 'acme' }), () => f.llmsFullPlan({ slug: 'acme' }), () => f.markdown({ slug: 'acme', path: 'welcome' })]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

describe('PublicSitesService.resolveTagged (the render cache’s check)', () => {
  it('a matching tag answers without reading the page body; anything else reads it', async () => {
    const { service, documents } = reader();
    const first = await service.resolveTagged({ slug: 'acme', path: '/welcome/install' });
    expect(first.body!.page!.markdown).toBe('body of install-r5');
    expect(documents.getContent).toHaveBeenCalledTimes(1);

    const again = await service.resolveTagged({ slug: 'acme', path: '/welcome/install' }, first.etag);
    expect(again).toEqual({ etag: first.etag, body: null });
    expect(documents.getContent).toHaveBeenCalledTimes(1);

    const stale = await service.resolveTagged({ slug: 'acme', path: '/welcome/install' }, '"stale"');
    expect(stale.body!.page!.markdown).toBe('body of install-r5');
  });

  it('the tag changes with the pinned revision, the tree, a rebuild and the theme', async () => {
    const { service, prisma } = reader();
    const tag = async () => (await service.resolveTagged({ slug: 'acme', path: '/welcome/install' })).etag;
    const tags = [await tag()];
    prisma.pages[1].revisionId = 'install-r6';
    tags.push(await tag());
    prisma.pages[0].title = 'Welcome!';
    tags.push(await tag());
    prisma.versions[0].builtAt = new Date('2026-10-14T00:00:00Z');
    tags.push(await tag());
    prisma.site.theme = { ...prisma.site.theme, primaryColor: '#654321' };
    tags.push(await tag());
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('is no way around the live check: a cached tag for an unpublished site is still a 404', async () => {
    const { service, prisma } = reader();
    const { etag } = await service.resolveTagged({ slug: 'acme', path: '/' });
    prisma.site.status = 'draft';
    await expect(service.resolveTagged({ slug: 'acme', path: '/' }, etag)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('audiences: a page the reader may not see does not exist for them', () => {
  /** Install (a child of the home) kept to members in the latest version. */
  function restricted(stamp: { audience: string; audienceClaims?: unknown } = { audience: 'members' }) {
    const r = files();
    const row = r.prisma.pages.find((p) => p.versionId === V_LATEST && p.documentId === DOC_INSTALL)!;
    row.audience = stamp.audience;
    row.audienceClaims = stamp.audienceClaims ?? null;
    return r;
  }

  it('anonymous: gone from the tree, its path answers no page, and the site says it has more', async () => {
    const { service } = restricted();
    const res = await service.resolve({ slug: 'acme', path: '/welcome/install' });
    expect(res.tree.map((n) => n.documentId)).toEqual([DOC_HOME]);
    expect(res.page).toBeNull();
    expect(res.viewer).toBe('anonymous');
    expect(res.site.restricted).toBe(true);
    expect(res.site.signInUrl).toBe(`https://kb.example.com/site-sign-in?site=${SITE}`);
  });

  it('a site with every page public offers no sign-in', async () => {
    const res = await files().service.resolve({ slug: 'acme', path: '/' });
    expect(res.site).toMatchObject({ restricted: false, signInUrl: null });
  });

  it('a member sees it, and the cookie is what decides', async () => {
    const { service, sessions } = restricted();
    sessions.viewer.mockResolvedValue({ kind: 'member' });
    const res = await service.resolve({ slug: 'acme', path: '/welcome/install' }, 'kn_site_x=1');
    expect(sessions.viewer).toHaveBeenCalledWith(expect.objectContaining({ id: SITE }), 'kn_site_x=1');
    expect(res.page?.documentId).toBe(DOC_INSTALL);
    expect(res.viewer).toBe('member');
  });

  it('a visitors page: only a visitor whose claims match; members-only pages stay hidden from visitors', async () => {
    const { service, sessions } = restricted({ audience: 'visitors', audienceClaims: { plan: ['pro'] } });
    sessions.viewer.mockResolvedValue({ kind: 'visitor', claims: { plan: 'free' } });
    expect((await service.resolve({ slug: 'acme', path: '/welcome/install' })).page).toBeNull();
    sessions.viewer.mockResolvedValue({ kind: 'visitor', claims: { plan: ['basic', 'pro'] } });
    expect((await service.resolve({ slug: 'acme', path: '/welcome/install' })).page?.documentId).toBe(DOC_INSTALL);

    const members = restricted({ audience: 'members' });
    members.sessions.viewer.mockResolvedValue({ kind: 'visitor', claims: { plan: 'pro' } });
    expect((await members.service.resolve({ slug: 'acme', path: '/welcome/install' })).page).toBeNull();
  });

  it('a child of a hidden page is hidden too, even if its own stamp says public', async () => {
    const { service, prisma } = files();
    prisma.pages.find((p) => p.versionId === V_LATEST && p.documentId === DOC_HOME)!.audience = 'members';
    const res = await service.resolve({ slug: 'acme', path: '/welcome/install' });
    expect(res.tree).toEqual([]);
    expect(res.page).toBeNull();
  });

  it('the ETag differs between viewers, so a cached render never crosses a sign-in', async () => {
    const { service, sessions } = restricted();
    const anonymous = await service.resolveTagged({ slug: 'acme', path: '/' });
    sessions.viewer.mockResolvedValue({ kind: 'member' });
    const member = await service.resolveTagged({ slug: 'acme', path: '/' }, anonymous.etag);
    expect(member.body).not.toBeNull();
    expect(member.etag).not.toBe(anonymous.etag);
  });

  it('an attachment of a hidden page is a 404; the member gets it', async () => {
    const { service, sessions } = restricted();
    await expect(service.attachmentUrl(SITE, V_LATEST, ATT_INSTALL, false)).rejects.toBeInstanceOf(NotFoundException);
    sessions.viewer.mockResolvedValue({ kind: 'member' });
    await expect(service.attachmentUrl(SITE, V_LATEST, ATT_INSTALL, false, 'kn_site_x=1')).resolves.toContain(DOC_INSTALL);
  });

  it('another version does not name it as an alternate to a reader who may not see it there', async () => {
    const { service, prisma } = files();
    prisma.pages.push({ versionId: V_OLD, documentId: DOC_INSTALL, revisionId: 'install-r1', parentId: DOC_HOME, position: 0, depth: 1, slugPath: 'welcome/install', title: 'Install', audience: 'members', audienceClaims: null });
    const res = await service.resolve({ slug: 'acme', path: '/welcome/install' });
    expect(res.page?.alternates).toEqual([]);
  });

  it('sitemap, llms.txt and llms-full.txt list public pages only, whoever asks; the .md is a 404', async () => {
    const { files: f, sessions } = restricted();
    sessions.viewer.mockResolvedValue({ kind: 'member' }); // never consulted
    expect((await f.sitemap({ slug: 'acme' })).body).not.toContain('install');
    expect((await f.llmsIndex({ slug: 'acme' })).body).not.toContain('Install');
    expect((await f.llmsFullPlan({ slug: 'acme' })).pages.map((p) => p.documentId)).toEqual([DOC_HOME]);
    await expect(f.markdown({ slug: 'acme', path: 'welcome/install' })).rejects.toBeInstanceOf(NotFoundException);
    expect(sessions.viewer).not.toHaveBeenCalled();
  });

  it('a restamp alone (no build) changes the files’ ETags', async () => {
    const { files: f, prisma } = files();
    const before = await f.sitemap({ slug: 'acme' });
    prisma.pages.find((p) => p.versionId === V_LATEST && p.documentId === DOC_INSTALL)!.audience = 'members';
    const after = await f.sitemap({ slug: 'acme' }, before.etag);
    expect(after.body).not.toBeNull();
    expect(after.etag).not.toBe(before.etag);
  });
});
