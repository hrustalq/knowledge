import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PublishedSite, SiteDomain, SiteVersion, SiteVersionPage } from '@prisma/client';
import {
  normalizeHostname,
  normalizeSiteTheme,
  siteHomeDocumentId,
  sitePagePath,
  siteRootUrl,
  type PublicSiteLogo,
  type PublicSitePage,
  type PublicSiteResolveResponse,
  type PublicSiteTreeNode,
  type PublicSiteVersionRef,
} from '@knowledge/contracts';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { AvatarsService } from '../avatars/avatars.service.js';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { etagMatches } from '../ai-readable/render.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublishingSettingsService } from '../publishing/publishing-settings.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest path a resolve will look at; anything longer is no page of ours. */
const MAX_PATH_CHARS = 2000;

/** Bumped when the resolve answer changes shape, so every cached render goes stale. */
const RESOLVE_FORMAT_VERSION = 1;

/**
 * A snapshot row without its search text (up to 100k characters a page),
 * which nothing but search needs. Every other read of the rows selects this.
 */
export const SNAPSHOT_ROW = {
  documentId: true,
  revisionId: true,
  parentId: true,
  position: true,
  depth: true,
  slugPath: true,
  title: true,
} as const satisfies Prisma.SiteVersionPageSelect;
export type SnapshotRow = Pick<SiteVersionPage, keyof typeof SNAPSHOT_ROW>;

type BuiltVersion = SiteVersion & { builtAt: Date };
/** A site that may be read: live, allowed, and built. `domains` holds its verified hostnames, oldest first. */
export type LiveSite = PublishedSite & { versions: BuiltVersion[]; defaultVersion: BuiltVersion; domains: SiteDomain[] };

/** How a request names a site: its slug (path mode, or a base-domain host), or a custom hostname. */
export type SiteKey = { slug: string } | { hostname: string };

export interface ResolveQuery {
  /** Path mode: `/pub/<slug>/…`. */
  slug?: string;
  /** Host mode: `<slug>.PUBLISH_BASE_DOMAIN`. */
  host?: string;
  /** Below the site root, e.g. `/v1.2/guides/install`. */
  path?: string;
  /** The page the reader was on, when switching versions: kept if the target version has it. */
  from?: string;
}

/**
 * The anonymous read side of published sites (docs/features/44).
 *
 * Reads a version's snapshot and nothing else: `site_version_pages` names the
 * pages and pins their revisions, so a draft, a page added since the build,
 * or a revision that never indexed cannot be reached from here, whatever id
 * a caller sends. An attachment is served only when its page is in the
 * snapshot. Every request re-reads the site, its status and the workspace
 * switch — no authorisation is cached — so unpublishing, or turning sites
 * off, ends a site on the next request.
 *
 * A site that is unknown, not live, switched off or never built is a 404 like
 * any other, and so is everything under it.
 */
@Injectable()
export class PublicSitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PublishingSettingsService,
    private readonly documents: DocumentsService,
    private readonly attachments: AttachmentsService,
    private readonly avatars: AvatarsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async resolve(query: ResolveQuery): Promise<PublicSiteResolveResponse> {
    return (await this.resolveTagged(query)).body!;
  }

  /**
   * `resolve` with an ETag, for the reader's render cache (issue #77 phase
   * 2b-2). The tag covers the whole answer with the page's markdown replaced
   * by the revision the snapshot pinned, which names it exactly. So it is
   * known before the one expensive read, the body from object storage, and a
   * caller whose tag still matches gets `body: null` without that read.
   *
   * Authorisation is not part of the bargain: the site is looked up afresh
   * first, so an unpublished site is a 404 whatever tag is sent.
   */
  async resolveTagged(query: ResolveQuery, ifNoneMatch?: string): Promise<{ etag: string; body: PublicSiteResolveResponse | null }> {
    const site = await this.find(query);
    const path = (query.path ?? '').slice(0, MAX_PATH_CHARS);
    const { version, slugPath } = this.splitPath(site, path);

    const rows = await this.prisma.siteVersionPage.findMany({
      where: { versionId: version.id },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
      select: SNAPSHOT_ROW,
    });
    const page = this.pickPage(rows, slugPath, query.from);

    const project = await this.prisma.project.findUnique({
      where: { id: site.projectId },
      select: { name: true, avatarKey: true, avatarEmoji: true, avatarColor: true, avatarUpdatedAt: true },
    });
    const theme = normalizeSiteTheme(site.theme);

    const body: PublicSiteResolveResponse = {
      site: {
        id: site.id,
        slug: site.slug,
        title: project?.name ?? site.slug,
        theme,
        seoIndexable: site.seoIndexable,
        logo: theme.showLogo && project ? this.logo(site.id, project) : null,
        rootUrl: this.rootUrl(site),
      },
      version: { ...this.versionRef(version, site), id: version.id, builtAt: version.builtAt.toISOString() },
      versions: site.versions.map((v) => this.versionRef(v, site)),
      tree: rows.map(
        (r): PublicSiteTreeNode => ({
          documentId: r.documentId,
          parentId: r.parentId,
          title: r.title,
          slugPath: r.slugPath,
          position: r.position,
        }),
      ),
      page: page ? await this.pageMeta(page, site, version) : null,
    };
    const etag = `"${createHash('sha256')
      .update(JSON.stringify([RESOLVE_FORMAT_VERSION, body, page?.revisionId ?? null]))
      .digest('hex')
      .slice(0, 32)}"`;
    if (etagMatches(ifNoneMatch, etag)) return { etag, body: null };

    if (page && body.page) {
      // The one content path (CLAUDE.md), at the revision the snapshot pinned.
      // A revision that can no longer be read (its page was deleted) is as
      // absent as a page that was never published.
      const content = await this.documents.getContent(page.documentId, page.revisionId).catch(() => null);
      if (content) body.page.markdown = content.markdown;
      else body.page = null;
    }
    return { etag, body };
  }

  /**
   * The live site a request names, by slug or host. 404 for anything that is
   * not a live, allowed, built site — the one authorisation check every
   * public site route goes through.
   */
  async find(query: { slug?: string; host?: string }): Promise<LiveSite> {
    const key = query.slug ? { slug: query.slug } : query.host ? this.siteKeyFromHost(query.host) : null;
    if (!key) throw this.notFound();
    return this.liveSite(key);
  }

  /** The live site behind an id the reader already holds (search, attachments): the same check as `find`. */
  findById(siteId: string): Promise<LiveSite> {
    return this.liveSite({ id: siteId });
  }

  /** A version's first segment and the slug path below it. */
  splitPath(site: LiveSite, path: string): { version: BuiltVersion; slugPath: string } {
    const segments = path
      .slice(0, MAX_PATH_CHARS)
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    // A version owns a URL's first segment; the default version has none of
    // its own (its slug also works, and the reader redirects to the bare path).
    const named = segments.length ? site.versions.find((v) => v.slug === segments[0]) : undefined;
    return { version: named ?? site.defaultVersion, slugPath: (named ? segments.slice(1) : segments).join('/') };
  }

  /**
   * Absolute URL of the site's root, for canonical links, the sitemap and
   * llms.txt: its first verified domain while custom domains are routed, else
   * its subdomain or path.
   */
  rootUrl(site: LiveSite): string {
    const customDomains = this.config.get('SITE_CUSTOM_DOMAINS', { infer: true });
    return siteRootUrl(site.slug, {
      baseDomain: this.config.get('PUBLISH_BASE_DOMAIN', { infer: true }),
      webBaseUrl: this.config.get('WEB_BASE_URL', { infer: true }),
      domain: customDomains ? (site.domains[0]?.hostname ?? null) : null,
    });
  }

  /**
   * Caddy's on-demand TLS `ask` (`/v1/public/domains/allow`): may a
   * certificate be issued for this name? Yes for a name this platform routes
   * to a site its workspace may publish — a `<slug>.PUBLISH_BASE_DOMAIN` of an
   * existing site, or a verified custom domain — live or not, so a site that
   * goes live later is already reachable over HTTPS. Anything else is no, so
   * a stranger pointing names at the server cannot make it request
   * certificates for them.
   */
  async hostAllowed(rawHost: string): Promise<boolean> {
    const key = this.siteKeyFromHost(rawHost);
    if (!key) return false;
    const site =
      'slug' in key
        ? await this.prisma.publishedSite.findUnique({ where: { slug: key.slug }, select: { workspaceId: true } })
        : (await this.prisma.siteDomain.findFirst({
            where: { hostname: key.hostname, verifiedAt: { not: null } },
            select: { site: { select: { workspaceId: true } } },
          }))?.site;
    if (!site) return false;
    return (await this.settings.effective(site.workspaceId)).allowPublicSites;
  }

  /** A presigned URL for an attachment of a page in this version's snapshot. */
  async attachmentUrl(siteId: string, versionId: string, attachmentId: string, download: boolean): Promise<string> {
    const site = await this.liveSite({ id: siteId });
    if (!site.versions.some((v) => v.id === versionId)) throw this.notFound();
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, documentId: true, status: true },
    });
    if (!attachment || attachment.status !== 'ready') throw this.notFound();
    const published = await this.prisma.siteVersionPage.findUnique({
      where: { versionId_documentId: { versionId, documentId: attachment.documentId } },
      select: { documentId: true },
    });
    if (!published) throw this.notFound();
    return this.attachments.readUrl(attachment.documentId, attachment.id, download);
  }

  /** The project's uploaded avatar, which a theme may show as the site's logo. */
  async logoUrl(siteId: string): Promise<string> {
    const site = await this.liveSite({ id: siteId });
    if (!normalizeSiteTheme(site.theme).showLogo) throw this.notFound();
    return this.avatars.presignedGet('projects', site.projectId).catch(() => {
      throw this.notFound();
    });
  }

  /**
   * A request host → the site it names: `<slug>.PUBLISH_BASE_DOMAIN` by slug
   * (one label only, so `a.b.<base>` names nothing), any other host as a
   * custom domain while SITE_CUSTOM_DOMAINS is on. The base domain itself and
   * malformed hosts name nothing.
   */
  siteKeyFromHost(rawHost: string): SiteKey | null {
    const host = normalizeHostname(rawHost.trim().replace(/:\d+$/, ''));
    if (!host) return null;
    const base = this.config.get('PUBLISH_BASE_DOMAIN', { infer: true });
    if (base && (host === base || host.endsWith(`.${base}`))) {
      const label = host === base ? '' : host.slice(0, -(base.length + 1));
      return label && !label.includes('.') ? { slug: label } : null;
    }
    return this.config.get('SITE_CUSTOM_DOMAINS', { infer: true }) ? { hostname: host } : null;
  }

  // -------------------------------------------------------------------------

  private notFound(): NotFoundException {
    return new NotFoundException(t('error.site.notFound'));
  }

  /** The site, if it is live, its workspace allows sites, and its default version has built. */
  private async liveSite(key: SiteKey | { id: string }): Promise<LiveSite> {
    if ('id' in key && !UUID_RE.test(key.id)) throw this.notFound();
    let where: { slug: string } | { id: string };
    if ('hostname' in key) {
      if (!this.config.get('SITE_CUSTOM_DOMAINS', { infer: true })) throw this.notFound();
      const domain = await this.prisma.siteDomain.findFirst({
        where: { hostname: key.hostname, verifiedAt: { not: null } },
        select: { siteId: true },
      });
      if (!domain) throw this.notFound();
      where = { id: domain.siteId };
    } else {
      where = key;
    }
    const site = await this.prisma.publishedSite.findUnique({
      where,
      include: {
        versions: { where: { builtAt: { not: null } }, orderBy: { createdAt: 'asc' } },
        // The first verified name is the canonical root (see rootUrl).
        domains: { where: { verifiedAt: { not: null } }, orderBy: { verifiedAt: 'asc' } },
      },
    });
    if (!site || site.status !== 'live') throw this.notFound();
    if (!(await this.settings.effective(site.workspaceId)).allowPublicSites) throw this.notFound();
    const versions = site.versions as BuiltVersion[];
    const defaultVersion = versions.find((v) => v.id === site.defaultVersionId);
    if (!defaultVersion) throw this.notFound();
    // The default first, then the rest in the order they were made.
    return { ...site, versions: [defaultVersion, ...versions.filter((v) => v !== defaultVersion)], defaultVersion };
  }

  /**
   * The page a path names. The root path is the site's home: the page at `''`
   * when the site is published from one page, otherwise the first page in
   * reading order. When switching versions (`from`), a path the target does
   * not have falls back to the same page under its slug there, then to the
   * home — never to a 404 for a page the reader was just looking at.
   */
  private pickPage(rows: SnapshotRow[], slugPath: string, from: string | undefined): SnapshotRow | null {
    const homeId = siteHomeDocumentId(rows);
    const home = rows.find((r) => r.documentId === homeId) ?? null;
    if (!slugPath) return home;
    const exact = rows.find((r) => r.slugPath === slugPath);
    if (exact) return exact;
    if (from && UUID_RE.test(from)) return rows.find((r) => r.documentId === from) ?? home;
    return null;
  }

  /** Everything about a page but its body, which `resolveTagged` reads only when the tag has changed. */
  private async pageMeta(row: SnapshotRow, site: LiveSite, version: BuiltVersion): Promise<PublicSitePage> {
    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: row.revisionId },
      select: { finalizedAt: true },
    });
    return {
      documentId: row.documentId,
      title: row.title,
      slugPath: row.slugPath,
      markdown: '',
      updatedAt: revision?.finalizedAt?.toISOString() ?? null,
      alternates: await this.alternates(row.documentId, site, version),
    };
  }

  /**
   * Where the same page lives in the site's other built versions. Two reads
   * whatever the version count: the page's rows, and each version's top level
   * (to know whether the page is that version's home, which lives at its root).
   */
  private async alternates(documentId: string, site: LiveSite, current: BuiltVersion): Promise<PublicSitePage['alternates']> {
    const others = site.versions.filter((v) => v.id !== current.id);
    if (!others.length) return [];
    const ids = others.map((v) => v.id);
    const [mine, tops] = await Promise.all([
      this.prisma.siteVersionPage.findMany({ where: { documentId, versionId: { in: ids } }, select: { versionId: true, slugPath: true } }),
      this.prisma.siteVersionPage.findMany({
        where: { versionId: { in: ids }, parentId: null },
        select: { versionId: true, documentId: true, parentId: true, slugPath: true, position: true },
      }),
    ]);
    const out: PublicSitePage['alternates'] = [];
    for (const v of others) {
      const row = mine.find((r) => r.versionId === v.id);
      if (!row) continue;
      const isHome = siteHomeDocumentId(tops.filter((t) => t.versionId === v.id)) === documentId;
      const ref = this.versionRef(v, site);
      out.push({ version: ref, path: sitePagePath('', ref.isDefault ? null : v.slug, isHome ? '' : row.slugPath) });
    }
    return out;
  }

  private versionRef(version: SiteVersion, site: PublishedSite): PublicSiteVersionRef {
    return { slug: version.slug, name: version.name, isDefault: version.id === site.defaultVersionId };
  }

  private logo(
    siteId: string,
    project: { avatarKey: string | null; avatarEmoji: string | null; avatarColor: string | null; avatarUpdatedAt: Date | null },
  ): PublicSiteLogo {
    if (project.avatarKey) {
      // Cache-bust the reused object key (CLAUDE.md, web).
      const v = project.avatarUpdatedAt ? `?v=${project.avatarUpdatedAt.getTime()}` : '';
      return { kind: 'image', url: `/v1/public/sites/${siteId}/logo${v}` };
    }
    if (project.avatarEmoji) return { kind: 'emoji', emoji: project.avatarEmoji, color: project.avatarColor };
    return null;
  }
}
