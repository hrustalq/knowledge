import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PublishedSite, type SiteDomain, type SiteVersion } from '@prisma/client';
import {
  RESERVED_SITE_SLUGS,
  isValidSiteSlug,
  isValidVersionSlug,
  normalizeSiteTheme,
  siteRootUrl,
  siteThemeErrors,
  suggestSiteSlug,
  suggestVersionSlug,
  type ProjectSiteResponse,
  type PublishedSiteSummary,
  type SiteBuildWarning,
  type SiteTheme,
  type SiteVersionKind,
  type SiteVersionStatus,
  type SiteVersionSummary,
  type PublishedSiteStatus,
} from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublishingSettingsService } from './publishing-settings.service.js';
import { SiteBuildProducer } from './site-build.producer.js';
import { siteDomainSummary } from './site-domains.service.js';

/** The dev principal has no users row; same stub the rest of the API records. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/** Most versions one site keeps. Each is a full snapshot, rebuilt on its own. */
export const SITE_MAX_VERSIONS = 20;

/** The version every new site starts with: follows each page's default branch. */
const FIRST_VERSION = { name: 'Latest', slug: 'latest', kind: 'live' as const, sourceBranch: null };

export interface CreateSiteInput {
  slug: string;
  rootDocumentId?: string | null;
}

export interface UpdateSiteInput {
  slug?: string;
  rootDocumentId?: string | null;
  theme?: Partial<SiteTheme>;
  seoIndexable?: boolean;
  defaultVersionId?: string;
}

export interface CreateVersionInput {
  name: string;
  slug?: string;
  kind: SiteVersionKind;
  sourceBranch?: string | null;
}

export interface UpdateVersionInput {
  name?: string;
  kind?: SiteVersionKind;
  sourceBranch?: string | null;
}

type SiteRow = PublishedSite & { versions: SiteVersion[]; domains: SiteDomain[] };

/** Everything a site summary shows; one constant so no query forgets the domains. */
const SITE_INCLUDE = { versions: true, domains: { orderBy: { createdAt: 'asc' } } } as const satisfies Prisma.PublishedSiteInclude;

/**
 * Published sites: the management side (docs/features/44, issue #77 phase 2a).
 *
 * A site is a project (or one page and its subtree) served read-only to
 * anyone, so creating one and putting it live are gated twice, like share
 * links: PUBLIC_SITES_ENABLED is the ceiling and the workspace switch defaults
 * to off. A site can be configured while the switch is off; it cannot go live,
 * and a live one stops resolving the moment either is off.
 *
 * Builds are the worker's. Everything here only records what is wanted and
 * enqueues — a person's request skips the debounce, nothing else does.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PublishingSettingsService,
    private readonly activity: ActivityService,
    private readonly builds: SiteBuildProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async forProject(projectId: string): Promise<ProjectSiteResponse> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true, name: true, site: { include: SITE_INCLUDE } },
    });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    const settings = await this.settings.get(project.workspaceId);
    const baseDomain = this.config.get('PUBLISH_BASE_DOMAIN', { infer: true });
    return {
      site: project.site ? await this.toSummary(project.site) : null,
      policy: {
        enabled: settings.effective.allowPublicSites,
        ceiling: settings.ceiling.sitesEnabled,
        baseDomain: baseDomain || null,
        customDomains: this.config.get('SITE_CUSTOM_DOMAINS', { infer: true }),
        suggestedSlug: suggestSiteSlug(project.name),
      },
    };
  }

  async create(projectId: string, input: CreateSiteInput, actorId?: string): Promise<PublishedSiteSummary> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true, site: { select: { id: true } } },
    });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    await this.requireEnabled(project.workspaceId);
    if (project.site) throw new ConflictException({ statusCode: 409, message: t('error.site.exists'), reason: 'site.exists' });
    const slug = await this.checkSlug(input.slug);
    const rootDocumentId = await this.checkRoot(projectId, input.rootDocumentId ?? null);
    const createdBy = actorId ?? AUTHOR_ID_STUB;

    const site = await this.uniqueSlug(slug, () =>
      this.prisma.$transaction(async (tx) => {
        const row = await tx.publishedSite.create({
          data: { workspaceId: project.workspaceId, projectId, slug, rootDocumentId, createdBy },
        });
        const version = await tx.siteVersion.create({ data: { siteId: row.id, ...FIRST_VERSION, createdBy } });
        return tx.publishedSite.update({
          where: { id: row.id },
          data: { defaultVersionId: version.id },
          include: SITE_INCLUDE,
        });
      }),
    );
    await this.builds.enqueue(site.defaultVersionId!, { now: true });
    this.record(site, 'site.created', actorId, { slug });
    return this.toSummary(site);
  }

  async update(siteId: string, input: UpdateSiteInput, actorId?: string): Promise<PublishedSiteSummary> {
    const site = await this.requireSite(siteId);
    const data: Prisma.PublishedSiteUpdateInput = {};

    if (input.slug !== undefined && input.slug !== site.slug) data.slug = await this.checkSlug(input.slug);
    const rootChanged = input.rootDocumentId !== undefined && input.rootDocumentId !== site.rootDocumentId;
    if (rootChanged) data.rootDocumentId = await this.checkRoot(site.projectId, input.rootDocumentId ?? null);
    if (input.theme !== undefined) {
      const errors = siteThemeErrors(input.theme);
      if (errors.length) {
        throw new BadRequestException({
          statusCode: 400,
          message: t('error.site.themeInvalid', { fields: errors.join(', ') }),
          fields: errors,
        });
      }
      data.theme = normalizeSiteTheme({ ...normalizeSiteTheme(site.theme), ...input.theme }) as unknown as Prisma.InputJsonValue;
    }
    if (input.seoIndexable !== undefined) data.seoIndexable = input.seoIndexable;
    if (input.defaultVersionId !== undefined && input.defaultVersionId !== site.defaultVersionId) {
      const version = site.versions.find((v) => v.id === input.defaultVersionId);
      if (!version) throw new NotFoundException(t('error.site.versionNotFound'));
      if (!version.builtAt) throw new ConflictException({ statusCode: 409, message: t('error.site.versionNotBuilt'), reason: 'site.versionNotBuilt' });
      data.defaultVersionId = version.id;
    }

    const updated = await this.uniqueSlug(String(data.slug ?? site.slug), () =>
      this.prisma.publishedSite.update({ where: { id: siteId }, data, include: SITE_INCLUDE }),
    );
    // A new root is a different site: every version that follows its branch
    // re-snapshots. Frozen versions keep what they froze until rebuilt.
    if (rootChanged) {
      for (const v of updated.versions.filter((v) => v.kind === 'live')) await this.builds.enqueue(v.id, { now: true });
    }
    this.record(updated, 'site.updated', actorId, { changed: Object.keys(data) });
    return this.toSummary(updated);
  }

  async publish(siteId: string, actorId?: string): Promise<PublishedSiteSummary> {
    const site = await this.requireSite(siteId);
    await this.requireEnabled(site.workspaceId);
    return this.setStatus(site, 'live', 'site.published', actorId);
  }

  async unpublish(siteId: string, actorId?: string): Promise<PublishedSiteSummary> {
    const site = await this.requireSite(siteId);
    return this.setStatus(site, 'unpublished', 'site.unpublished', actorId);
  }

  /** Deletes the site and every version's snapshot; the pages themselves are untouched. Frees the slug. */
  async remove(siteId: string, actorId?: string): Promise<{ deleted: true }> {
    const site = await this.requireSite(siteId);
    await this.prisma.publishedSite.delete({ where: { id: siteId } });
    this.record(site, 'site.deleted', actorId, { slug: site.slug });
    return { deleted: true };
  }

  async createVersion(siteId: string, input: CreateVersionInput, actorId?: string): Promise<SiteVersionSummary> {
    const site = await this.requireSite(siteId);
    if (site.versions.length >= SITE_MAX_VERSIONS) {
      throw new ConflictException({ statusCode: 409, message: t('error.site.versionLimit', { max: SITE_MAX_VERSIONS }), reason: 'site.versionLimit' });
    }
    const name = input.name.trim();
    const slug = (input.slug ?? suggestVersionSlug(name)).trim();
    if (!isValidVersionSlug(slug)) throw new BadRequestException(t('error.site.versionSlugInvalid'));
    if (site.versions.some((v) => v.slug === slug)) {
      throw new ConflictException({ statusCode: 409, message: t('error.site.versionSlugTaken', { slug }), reason: 'site.versionSlugTaken' });
    }
    // A version owns the first segment of a URL. A top-level page already
    // there would vanish behind it, so the address is refused rather than
    // silently shadowing a page people may have linked to.
    if (site.defaultVersionId) {
      const shadowed = await this.prisma.siteVersionPage.findFirst({
        where: { versionId: site.defaultVersionId, depth: 0, slugPath: slug },
        select: { documentId: true },
      });
      if (shadowed) {
        throw new ConflictException({ statusCode: 409, message: t('error.site.versionSlugShadowsPage', { slug }), reason: 'site.versionSlugShadowsPage' });
      }
    }

    const version = await this.prisma.siteVersion.create({
      data: {
        siteId,
        name,
        slug,
        kind: input.kind,
        sourceBranch: input.sourceBranch?.trim() || null,
        createdBy: actorId ?? AUTHOR_ID_STUB,
      },
    });
    await this.builds.enqueue(version.id, { now: true });
    // The new slug is reserved at the top level from the next build on; live
    // versions pick that up without waiting for an edit.
    for (const v of site.versions.filter((v) => v.kind === 'live')) await this.builds.enqueue(v.id);
    this.record(site, 'site.version.created', actorId, { version: slug, kind: version.kind });
    return this.toVersionSummary(version, site.defaultVersionId);
  }

  async updateVersion(versionId: string, input: UpdateVersionInput, actorId?: string): Promise<SiteVersionSummary> {
    const version = await this.requireVersion(versionId);
    const data: Prisma.SiteVersionUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.kind !== undefined) data.kind = input.kind;
    const branchChanged = input.sourceBranch !== undefined && (input.sourceBranch?.trim() || null) !== version.sourceBranch;
    if (branchChanged) data.sourceBranch = input.sourceBranch?.trim() || null;
    const updated = await this.prisma.siteVersion.update({ where: { id: versionId }, data });
    if (branchChanged) await this.rebuild(versionId);
    this.record(version.site, 'site.version.updated', actorId, { version: version.slug, changed: Object.keys(data) });
    return this.toVersionSummary(updated, version.site.defaultVersionId);
  }

  async rebuild(versionId: string, actorId?: string): Promise<SiteVersionSummary> {
    const version = await this.requireVersion(versionId);
    const updated = await this.prisma.siteVersion.update({ where: { id: versionId }, data: { status: 'building', error: null } });
    await this.builds.enqueue(versionId, { now: true });
    if (actorId !== undefined) this.record(version.site, 'site.version.rebuilt', actorId, { version: version.slug });
    return this.toVersionSummary(updated, version.site.defaultVersionId);
  }

  async deleteVersion(versionId: string, actorId?: string): Promise<{ deleted: true }> {
    const version = await this.requireVersion(versionId);
    if (version.site.defaultVersionId === versionId) {
      throw new ConflictException({ statusCode: 409, message: t('error.site.defaultVersionDelete'), reason: 'site.defaultVersionDelete' });
    }
    await this.prisma.siteVersion.delete({ where: { id: versionId } });
    this.record(version.site, 'site.version.deleted', actorId, { version: version.slug });
    return { deleted: true };
  }

  // -------------------------------------------------------------------------

  /** Where a site is served: its first verified domain (while this deployment routes them), else its subdomain or path. */
  siteUrl(slug: string, domains: SiteDomain[] = []): string {
    const domain = this.config.get('SITE_CUSTOM_DOMAINS', { infer: true })
      ? (domains.filter((d) => d.verifiedAt).sort((a, b) => a.verifiedAt!.getTime() - b.verifiedAt!.getTime())[0]?.hostname ?? null)
      : null;
    return siteRootUrl(slug, {
      baseDomain: this.config.get('PUBLISH_BASE_DOMAIN', { infer: true }),
      webBaseUrl: this.config.get('WEB_BASE_URL', { infer: true }),
      domain,
    });
  }

  private async requireEnabled(workspaceId: string): Promise<void> {
    const settings = await this.settings.effective(workspaceId);
    if (!settings.allowPublicSites) {
      throw new ForbiddenException({ statusCode: 403, message: t('error.site.disabledByWorkspace'), reason: 'site.disabledByWorkspace' });
    }
  }

  private async requireSite(siteId: string): Promise<SiteRow> {
    const site = await this.prisma.publishedSite.findUnique({ where: { id: siteId }, include: SITE_INCLUDE });
    if (!site) throw new NotFoundException(t('error.site.notFound'));
    return site;
  }

  private async requireVersion(versionId: string): Promise<SiteVersion & { site: PublishedSite }> {
    const version = await this.prisma.siteVersion.findUnique({ where: { id: versionId }, include: { site: true } });
    if (!version) throw new NotFoundException(t('error.site.versionNotFound'));
    return version;
  }

  private async checkSlug(raw: string): Promise<string> {
    const slug = raw.trim().toLowerCase();
    if ((RESERVED_SITE_SLUGS as readonly string[]).includes(slug)) {
      throw new BadRequestException({ statusCode: 400, message: t('error.site.slugReserved', { slug }), reason: 'site.slugReserved' });
    }
    if (!isValidSiteSlug(slug)) throw new BadRequestException({ statusCode: 400, message: t('error.site.slugInvalid'), reason: 'site.slugInvalid' });
    const taken = await this.prisma.publishedSite.findUnique({ where: { slug }, select: { id: true } });
    if (taken) throw this.slugTaken(slug);
    return slug;
  }

  /** The pre-check above races a concurrent claim; the unique index settles it, as the same 409. */
  private async uniqueSlug<T>(slug: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw this.slugTaken(slug);
      throw e;
    }
  }

  private slugTaken(slug: string): ConflictException {
    return new ConflictException({ statusCode: 409, message: t('error.site.slugTaken', { slug }), reason: 'site.slugTaken' });
  }

  private async checkRoot(projectId: string, rootDocumentId: string | null): Promise<string | null> {
    if (rootDocumentId === null) return null;
    const doc = await this.prisma.document.findUnique({
      where: { id: rootDocumentId },
      select: { projectId: true, archivedAt: true },
    });
    if (!doc || doc.projectId !== projectId || doc.archivedAt) {
      throw new BadRequestException({ statusCode: 400, message: t('error.site.rootNotInProject'), reason: 'site.rootNotInProject' });
    }
    return rootDocumentId;
  }

  private async setStatus(site: SiteRow, status: PublishedSiteStatus, action: string, actorId?: string): Promise<PublishedSiteSummary> {
    if (site.status === status) return this.toSummary(site);
    const updated = await this.prisma.publishedSite.update({ where: { id: site.id }, data: { status }, include: SITE_INCLUDE });
    this.record(updated, action, actorId, { slug: updated.slug });
    return this.toSummary(updated);
  }

  private record(site: PublishedSite, action: string, actorId?: string, extra: Record<string, unknown> = {}): void {
    void this.activity.record({
      workspaceId: site.workspaceId,
      ...(actorId ? { actor: actorId } : {}),
      action,
      projectId: site.projectId,
      subjectId: site.id,
      metadata: { siteId: site.id, ...extra },
    });
  }

  private async toSummary(site: SiteRow): Promise<PublishedSiteSummary> {
    const root = site.rootDocumentId
      ? await this.prisma.document.findUnique({ where: { id: site.rootDocumentId }, select: { title: true } })
      : null;
    const versions = [...site.versions].sort(
      (a, b) =>
        Number(b.id === site.defaultVersionId) - Number(a.id === site.defaultVersionId) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return {
      id: site.id,
      workspaceId: site.workspaceId,
      projectId: site.projectId,
      slug: site.slug,
      status: site.status as PublishedSiteStatus,
      rootDocumentId: site.rootDocumentId,
      rootDocumentTitle: root?.title ?? null,
      theme: normalizeSiteTheme(site.theme),
      seoIndexable: site.seoIndexable,
      defaultVersionId: site.defaultVersionId,
      url: this.siteUrl(site.slug, site.domains),
      versions: versions.map((v) => this.toVersionSummary(v, site.defaultVersionId)),
      domains: site.domains.map((d) =>
        siteDomainSummary(d, site, {
          baseDomain: this.config.get('PUBLISH_BASE_DOMAIN', { infer: true }),
          webBaseUrl: this.config.get('WEB_BASE_URL', { infer: true }),
        }),
      ),
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    };
  }

  private toVersionSummary(v: SiteVersion, defaultVersionId: string | null): SiteVersionSummary {
    return {
      id: v.id,
      name: v.name,
      slug: v.slug,
      kind: v.kind as SiteVersionKind,
      sourceBranch: v.sourceBranch,
      status: v.status as SiteVersionStatus,
      builtAt: v.builtAt?.toISOString() ?? null,
      pageCount: v.pageCount,
      warnings: Array.isArray(v.warnings) ? (v.warnings as unknown as SiteBuildWarning[]) : [],
      error: v.error,
      isDefault: v.id === defaultVersionId,
      createdAt: v.createdAt.toISOString(),
    };
  }
}
