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
 *   shadow a top-level page, and the default version cannot be deleted.
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
  const pages = [
    { versionId: V_LATEST, documentId: DOC_HOME, revisionId: 'home-r3', parentId: null, position: 0, depth: 0, slugPath: 'welcome', title: 'Welcome' },
    { versionId: V_LATEST, documentId: DOC_INSTALL, revisionId: 'install-r5', parentId: DOC_HOME, position: 0, depth: 1, slugPath: 'welcome/install', title: 'Install' },
    // The frozen version pinned older revisions, and had no install page yet.
    { versionId: V_OLD, documentId: DOC_HOME, revisionId: 'home-r1', parentId: null, position: 0, depth: 0, slugPath: 'welcome', title: 'Welcome' },
  ];
  let settings: { allowPublicSites: boolean | null } | null = { allowPublicSites: true };
  const prisma = {
    site,
    versions,
    setSettings: (v: typeof settings) => (settings = v),
    publishingSettings: { findUnique: vi.fn(async () => settings) },
    publishedSite: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        const hit = where.slug ? site.slug === where.slug : site.id === where.id;
        if (!hit) return null;
        return { ...site, versions: versions.filter((v) => v.builtAt !== null) };
      }),
    },
    siteVersionPage: {
      findMany: vi.fn(async ({ where }: { where: { versionId: string } }) => pages.filter((p) => p.versionId === where.versionId)),
      findUnique: vi.fn(async ({ where }: { where: { versionId_documentId: { versionId: string; documentId: string } } }) =>
        pages.find((p) => p.versionId === where.versionId_documentId.versionId && p.documentId === where.versionId_documentId.documentId) ?? null,
      ),
    },
    project: {
      findUnique: vi.fn(async () => ({ name: 'Acme Docs', avatarKey: 'k', avatarEmoji: null, avatarColor: null, avatarUpdatedAt: new Date(5) })),
    },
    documentRevision: { findUnique: vi.fn(async () => ({ finalizedAt: built })) },
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
  const service = new PublicSitesService(prisma as never, settings, documents as never, attachments as never, avatars as never, config as never);
  return { prisma, service, documents, attachments };
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
    expect(res.site).toMatchObject({ title: 'Acme Docs', rootUrl: 'https://acme.docs.example.com' });
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

  it('resolves a site by its own host under PUBLISH_BASE_DOMAIN, and no other host', async () => {
    const { service } = reader();
    expect((await service.resolve({ host: 'ACME.docs.example.com:443', path: '/' })).site.slug).toBe('acme');
    expect(service.slugFromHost('acme.evil.com')).toBeNull();
    expect(service.slugFromHost('a.b.docs.example.com')).toBeNull();
    expect(reader({ PUBLISH_BASE_DOMAIN: '' }).service.slugFromHost('acme.docs.example.com')).toBeNull();
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
