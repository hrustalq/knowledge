import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PublishedSite, SiteDomain, SiteVersion, SiteVersionPage } from '@prisma/client';
import {
  effectiveSiteAskBudget,
  normalizeHostname,
  normalizeSiteTheme,
  siteHomeDocumentId,
  sitePagePath,
  siteRootUrl,
  siteViewerCanSee,
  type PublicSiteLogo,
  type PublicSitePage,
  type PublicSitePageRef,
  type PublicSiteResolveResponse,
  type PublicSiteTreeNode,
  type PublicSiteTreeResponse,
  type PublicSiteVersionRef,
  type PublicSiteWidgetResponse,
  type SiteViewer,
} from '@knowledge/contracts';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { AvatarsService } from '../avatars/avatars.service.js';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { etagMatches } from '../ai-readable/render.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublishingSettingsService } from '../publishing/publishing-settings.service.js';
import { SiteSessionService } from './site-session.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest path a resolve will look at; anything longer is no page of ours. */
const MAX_PATH_CHARS = 2000;

/** Bumped when the resolve answer changes shape, so every cached render goes stale. */
const RESOLVE_FORMAT_VERSION = 4;

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
  audience: true,
  audienceClaims: true,
} as const satisfies Prisma.SiteVersionPageSelect;
export type SnapshotRow = Pick<SiteVersionPage, keyof typeof SNAPSHOT_ROW>;

type BuiltVersion = SiteVersion & { builtAt: Date };
/** A site that may be read: live, allowed, and built. `domains` holds its verified hostnames, oldest first. */
export type LiveSite = PublishedSite & { versions: BuiltVersion[]; defaultVersion: BuiltVersion; domains: SiteDomain[] };

/**
 * The rows a viewer may read, in the order given (depth first, as every read
 * orders them). A row also needs its published parent visible: stamps fold
 * down the tree so that always holds, and checking it here means a stale
 * stamp can never show a page whose URL and nav place name a hidden parent.
 */
export function visibleRows<T extends Pick<SnapshotRow, 'documentId' | 'parentId' | 'audience' | 'audienceClaims'>>(
  rows: T[],
  viewer: SiteViewer,
): T[] {
  const kept = new Set<string>();
  return rows.filter((r) => {
    const ok = siteViewerCanSee(r, viewer) && (r.parentId === null || kept.has(r.parentId));
    if (ok) kept.add(r.documentId);
    return ok;
  });
}

/**
 * Visible rows in reading order: depth first, siblings by position then title
 * — the order of the reader's nav, its prev/next and the site's home rule.
 */
export function readingOrder<T extends Pick<SnapshotRow, 'documentId' | 'parentId' | 'position' | 'title'>>(rows: T[]): T[] {
  const children = new Map<string | null, T[]>();
  for (const r of rows) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const out: T[] = [];
  const walk = (parent: string | null) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    for (const r of list) {
      out.push(r);
      walk(r.documentId);
    }
  };
  walk(null);
  return out;
}

/**
 * One level of the visible tree as nav nodes: the children of `parentId`
 * (null = the top level), each with how many children of its own the viewer
 * may see. `rows` are already filtered by `visibleRows`.
 */
export function treeLevel(rows: SnapshotRow[], parentIds: ReadonlySet<string | null>): PublicSiteTreeNode[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.parentId) counts.set(r.parentId, (counts.get(r.parentId) ?? 0) + 1);
  return readingOrder(rows)
    .filter((r) => parentIds.has(r.parentId))
    .map((r) => ({
      documentId: r.documentId,
      parentId: r.parentId,
      title: r.title,
      slugPath: r.slugPath,
      position: r.position,
      childCount: counts.get(r.documentId) ?? 0,
    }));
}

/** `/documents/<id>` references in a page body: the targets its links and mentions name. */
const PAGE_LINK_RE = /\/documents\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

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
 *
 * Who is reading decides which of the snapshot's rows exist (issue #77 phase
 * 3): a page the viewer may not see is absent from the tree, answers 404 as a
 * path, and its attachments 404 — never 403, so its existence is not
 * confirmed. The viewer is looked up afresh from the cookie on every request.
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
    private readonly sessions: SiteSessionService,
  ) {}

  async resolve(query: ResolveQuery, cookieHeader?: string): Promise<PublicSiteResolveResponse> {
    return (await this.resolveTagged(query, undefined, cookieHeader)).body!;
  }

  /** Who the request's site cookie says is reading. */
  viewer(site: LiveSite, cookieHeader: string | undefined): Promise<SiteViewer> {
    return this.sessions.viewer(site, cookieHeader);
  }

  /**
   * `resolve` with an ETag, for the reader's render cache (issue #77 phase
   * 2b-2). The tag covers the whole answer with the page's markdown replaced
   * by the revision the snapshot pinned, which names it exactly. So it is
   * known before the one expensive read, the body from object storage, and a
   * caller whose tag still matches gets `body: null` without that read.
   *
   * Authorisation is not part of the bargain: the site is looked up afresh
   * first, so an unpublished site is a 404 whatever tag is sent. The viewer
   * is part of the answer, so a tag never carries a render across sign-ins.
   */
  async resolveTagged(
    query: ResolveQuery,
    ifNoneMatch?: string,
    cookieHeader?: string,
  ): Promise<{ etag: string; body: PublicSiteResolveResponse | null }> {
    const site = await this.find(query);
    const path = (query.path ?? '').slice(0, MAX_PATH_CHARS);
    const { version, slugPath } = this.splitPath(site, path);

    const [all, viewer] = await Promise.all([
      this.prisma.siteVersionPage.findMany({
        where: { versionId: version.id },
        orderBy: [{ depth: 'asc' }, { position: 'asc' }],
        select: SNAPSHOT_ROW,
      }),
      this.sessions.viewer(site, cookieHeader),
    ]);
    const rows = visibleRows(all, viewer);
    const restricted = all.some((r) => r.audience !== 'public');
    const page = this.pickPage(rows, slugPath, query.from);

    // The nav's first render (issue #204): the top level and the children of
    // every page on the open path, never the whole tree. Expanding anything
    // else asks the tree route for that one level.
    const byId = new Map(rows.map((r) => [r.documentId, r]));
    const openPath = new Set<string | null>([null]);
    for (let id: string | null = page?.documentId ?? null; id; id = byId.get(id)?.parentId ?? null) openPath.add(id);

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
        restricted,
        signInUrl: restricted ? this.signInUrl(site.id) : null,
        ask: this.askOn(site),
      },
      viewer: viewer.kind,
      version: { ...this.versionRef(version, site), id: version.id, builtAt: version.builtAt.toISOString() },
      versions: site.versions.map((v) => this.versionRef(v, site)),
      tree: treeLevel(rows, openPath),
      page: page ? await this.pageMeta(page, rows, site, version, viewer) : null,
    };
    const etag = `"${createHash('sha256')
      // The visible set, not just the trimmed tree: the body's links are
      // resolved against it after this tag, so two viewers who see different
      // pages must never share one.
      .update(JSON.stringify([RESOLVE_FORMAT_VERSION, body, page?.revisionId ?? null, rows.map((r) => r.documentId)]))
      .digest('hex')
      .slice(0, 32)}"`;
    if (etagMatches(ifNoneMatch, etag)) return { etag, body: null };

    if (page && body.page) {
      // The one content path (CLAUDE.md), at the revision the snapshot pinned.
      // A revision that can no longer be read (its page was deleted) is as
      // absent as a page that was never published.
      const content = await this.documents.getContent(page.documentId, page.revisionId).catch(() => null);
      if (content) {
        body.page.markdown = content.markdown;
        body.page.links = this.pageLinks(content.markdown, byId);
      } else body.page = null;
    }
    return { etag, body };
  }

  /**
   * One level of a version's tree as this viewer sees it (issue #204): what
   * the reader asks for when someone expands a branch. A parent the viewer may
   * not see — or that is not in the version — is a 404 like a missing site, so
   * the answer never confirms a hidden page exists.
   */
  async children(
    siteId: string,
    query: { parent?: string; version?: string },
    cookieHeader?: string,
  ): Promise<PublicSiteTreeResponse> {
    const site = await this.liveSite({ id: siteId });
    const version = query.version ? site.versions.find((v) => v.slug === query.version) : site.defaultVersion;
    if (!version) throw this.notFound();
    const parent = query.parent ?? null;
    if (parent !== null && !UUID_RE.test(parent)) throw this.notFound();
    const [all, viewer] = await Promise.all([
      this.prisma.siteVersionPage.findMany({
        where: { versionId: version.id },
        orderBy: [{ depth: 'asc' }, { position: 'asc' }],
        select: SNAPSHOT_ROW,
      }),
      this.sessions.viewer(site, cookieHeader),
    ]);
    const rows = visibleRows(all, viewer);
    if (parent !== null && !rows.some((r) => r.documentId === parent)) throw this.notFound();
    return { nodes: treeLevel(rows, new Set([parent])) };
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
   * An absolute URL on one of this site's own addresses, split into its
   * origin and its path + query — or null for anywhere else. The addresses:
   * `/pub/<slug>` under WEB_BASE_URL (path mode, which always works), its
   * `<slug>.PUBLISH_BASE_DOMAIN` host, and its verified custom domains while
   * those are routed. Sign-in sends the browser back only to these.
   */
  siteAddress(site: LiveSite, raw: string): { origin: string; path: string } | null {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    const path = `${url.pathname}${url.search}`;
    const app = new URL(this.config.get('WEB_BASE_URL', { infer: true }));
    const pathPrefix = `/pub/${site.slug}`;
    if (url.origin === app.origin) {
      return url.pathname === pathPrefix || url.pathname.startsWith(`${pathPrefix}/`) ? { origin: url.origin, path } : null;
    }
    const key = this.siteKeyFromHost(url.host);
    if (!key) return null;
    const ours =
      'slug' in key ? key.slug === site.slug : site.domains.some((d) => d.hostname === key.hostname);
    return ours ? { origin: url.origin, path } : null;
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

  /** A presigned URL for an attachment of a page in this version's snapshot that the viewer may read. */
  async attachmentUrl(
    siteId: string,
    versionId: string,
    attachmentId: string,
    download: boolean,
    cookieHeader?: string,
  ): Promise<string> {
    const site = await this.liveSite({ id: siteId });
    if (!site.versions.some((v) => v.id === versionId)) throw this.notFound();
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, documentId: true, status: true },
    });
    if (!attachment || attachment.status !== 'ready') throw this.notFound();
    const published = await this.prisma.siteVersionPage.findUnique({
      where: { versionId_documentId: { versionId, documentId: attachment.documentId } },
      select: { documentId: true, audience: true, audienceClaims: true },
    });
    if (!published) throw this.notFound();
    if (published.audience !== 'public' && !siteViewerCanSee(published, await this.sessions.viewer(site, cookieHeader))) {
      throw this.notFound();
    }
    return this.attachments.readUrl(attachment.documentId, attachment.id, download);
  }

  /**
   * What the Ask widget's frame needs (issue #77 phase 3), by slug or host:
   * the site's chrome and the origins that may frame it. 404 unless the site
   * is live and answers questions, so a frame on a site without Ask renders
   * nothing and the embed script never shows its button.
   */
  async widget(query: { slug?: string; host?: string }): Promise<PublicSiteWidgetResponse> {
    const site = await this.find(query);
    if (!this.askOn(site)) throw this.notFound();
    const project = await this.prisma.project.findUnique({
      where: { id: site.projectId },
      select: { name: true, avatarKey: true, avatarEmoji: true, avatarColor: true, avatarUpdatedAt: true },
    });
    const theme = normalizeSiteTheme(site.theme);
    return {
      site: {
        id: site.id,
        title: project?.name ?? site.slug,
        theme,
        logo: theme.showLogo && project ? this.logo(site.id, project) : null,
        rootUrl: this.rootUrl(site),
      },
      embedOrigins: site.embedOrigins,
    };
  }

  /** Ask is on and the budget under the env ceiling leaves it something to answer with. */
  private askOn(site: PublishedSite): boolean {
    return site.askEnabled && effectiveSiteAskBudget(site.askDailyBudget, this.config.get('PUBLIC_ASK_DAILY_BUDGET', { infer: true })) > 0;
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

  /** The app page that signs a member in to this site (`SiteSignInPage`); the reader adds `return`. */
  private signInUrl(siteId: string): string {
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/site-sign-in?site=${encodeURIComponent(siteId)}`;
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
  private async pageMeta(
    row: SnapshotRow,
    rows: SnapshotRow[],
    site: LiveSite,
    version: BuiltVersion,
    viewer: SiteViewer,
  ): Promise<PublicSitePage> {
    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: row.revisionId },
      select: { finalizedAt: true },
    });
    // Prev/next walk the whole reading order, which the trimmed tree no longer
    // carries, so they are settled here.
    const order = readingOrder(rows);
    const at = order.findIndex((r) => r.documentId === row.documentId);
    const ref = (r: SnapshotRow | undefined): PublicSitePageRef | null =>
      r ? { documentId: r.documentId, title: r.title, slugPath: r.slugPath } : null;
    return {
      documentId: row.documentId,
      title: row.title,
      slugPath: row.slugPath,
      markdown: '',
      updatedAt: revision?.finalizedAt?.toISOString() ?? null,
      alternates: await this.alternates(row.documentId, site, version, viewer),
      prev: at > 0 ? ref(order[at - 1]) : null,
      next: at >= 0 ? ref(order[at + 1]) : null,
      // Filled in with the body, which is read only when the ETag has changed.
      links: [],
    };
  }

  /** The visible pages a body links to, with where each lives. */
  private pageLinks(markdown: string, byId: Map<string, SnapshotRow>): PublicSitePage['links'] {
    const ids = new Set(Array.from(markdown.matchAll(PAGE_LINK_RE), (m) => m[1].toLowerCase()));
    return [...ids].flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ documentId: row.documentId, slugPath: row.slugPath }] : [];
    });
  }

  /**
   * Where the same page lives in the site's other built versions. Two reads
   * whatever the version count: the page's rows, and each version's top level
   * (to know whether the page is that version's home, which lives at its root).
   * A version where the viewer may not see the page names no alternate.
   */
  private async alternates(
    documentId: string,
    site: LiveSite,
    current: BuiltVersion,
    viewer: SiteViewer,
  ): Promise<PublicSitePage['alternates']> {
    const others = site.versions.filter((v) => v.id !== current.id);
    if (!others.length) return [];
    const ids = others.map((v) => v.id);
    const [mine, tops] = await Promise.all([
      this.prisma.siteVersionPage.findMany({
        where: { documentId, versionId: { in: ids } },
        select: { versionId: true, slugPath: true, audience: true, audienceClaims: true },
      }),
      this.prisma.siteVersionPage.findMany({
        where: { versionId: { in: ids }, parentId: null },
        select: { versionId: true, documentId: true, parentId: true, slugPath: true, position: true, audience: true, audienceClaims: true },
      }),
    ]);
    const out: PublicSitePage['alternates'] = [];
    for (const v of others) {
      const row = mine.find((r) => r.versionId === v.id);
      if (!row || !siteViewerCanSee(row, viewer)) continue;
      const isHome = siteHomeDocumentId(tops.filter((t) => t.versionId === v.id && siteViewerCanSee(t, viewer))) === documentId;
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
