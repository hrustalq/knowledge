import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublishedSite, SiteVersion, SiteVersionPage } from '@prisma/client';
import {
  normalizeSiteTheme,
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
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublishingSettingsService } from '../publishing/publishing-settings.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest path a resolve will look at; anything longer is no page of ours. */
const MAX_PATH_CHARS = 2000;

type BuiltVersion = SiteVersion & { builtAt: Date };
type LiveSite = PublishedSite & { versions: BuiltVersion[]; defaultVersion: BuiltVersion };

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
    const slug = query.slug ?? (query.host ? this.slugFromHost(query.host) : null);
    if (!slug) throw this.notFound();
    const site = await this.liveSite({ slug });
    const path = (query.path ?? '').slice(0, MAX_PATH_CHARS);
    const segments = path
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
    const version = named ?? site.defaultVersion;
    const slugPath = (named ? segments.slice(1) : segments).join('/');

    const rows = await this.prisma.siteVersionPage.findMany({
      where: { versionId: version.id },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
    });
    const page = this.pickPage(rows, slugPath, query.from);

    const project = await this.prisma.project.findUnique({
      where: { id: site.projectId },
      select: { name: true, avatarKey: true, avatarEmoji: true, avatarColor: true, avatarUpdatedAt: true },
    });
    const theme = normalizeSiteTheme(site.theme);

    return {
      site: {
        id: site.id,
        slug: site.slug,
        title: project?.name ?? site.slug,
        theme,
        seoIndexable: site.seoIndexable,
        logo: theme.showLogo && project ? this.logo(site.id, project) : null,
        rootUrl: siteRootUrl(site.slug, {
          baseDomain: this.config.get('PUBLISH_BASE_DOMAIN', { infer: true }),
          webBaseUrl: this.config.get('WEB_BASE_URL', { infer: true }),
        }),
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
      page: page ? await this.pageBody(page) : null,
    };
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

  /** `<slug>.PUBLISH_BASE_DOMAIN` → slug; any other host names no site (custom domains are phase 2b). */
  slugFromHost(rawHost: string): string | null {
    const base = this.config.get('PUBLISH_BASE_DOMAIN', { infer: true });
    if (!base) return null;
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const suffix = `.${base}`;
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    return label && !label.includes('.') ? label : null;
  }

  // -------------------------------------------------------------------------

  private notFound(): NotFoundException {
    return new NotFoundException(t('error.site.notFound'));
  }

  /** The site, if it is live, its workspace allows sites, and its default version has built. */
  private async liveSite(where: { slug: string } | { id: string }): Promise<LiveSite> {
    if ('id' in where && !UUID_RE.test(where.id)) throw this.notFound();
    const site = await this.prisma.publishedSite.findUnique({
      where,
      include: { versions: { where: { builtAt: { not: null } }, orderBy: { createdAt: 'asc' } } },
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
  private pickPage(rows: SiteVersionPage[], slugPath: string, from: string | undefined): SiteVersionPage | null {
    const home = rows.find((r) => r.slugPath === '') ?? rows.find((r) => r.depth === 0) ?? null;
    if (!slugPath) return home;
    const exact = rows.find((r) => r.slugPath === slugPath);
    if (exact) return exact;
    if (from && UUID_RE.test(from)) return rows.find((r) => r.documentId === from) ?? home;
    return null;
  }

  private async pageBody(row: SiteVersionPage): Promise<PublicSitePage | null> {
    // The one content path (CLAUDE.md), at the revision the snapshot pinned.
    // A revision that can no longer be read (its page was deleted) is as
    // absent as a page that was never published.
    const content = await this.documents.getContent(row.documentId, row.revisionId).catch(() => null);
    if (!content) return null;
    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: row.revisionId },
      select: { finalizedAt: true },
    });
    return {
      documentId: row.documentId,
      title: row.title,
      slugPath: row.slugPath,
      markdown: content.markdown,
      updatedAt: revision?.finalizedAt?.toISOString() ?? null,
    };
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
