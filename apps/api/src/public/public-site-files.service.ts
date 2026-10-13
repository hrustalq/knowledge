import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SiteVersion } from '@prisma/client';
import { siteHomeDocumentId, siteMarkdownPath, sitePagePath } from '@knowledge/contracts';
import { orderPages, renderFullHeader, renderFullPage, renderLlmsIndex, truncatedMarker, unavailableMarker } from '../ai-readable/llms.js';
import { etagMatches as matches, titledMarkdown } from '../ai-readable/render.js';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublicSitesService, SNAPSHOT_ROW, type LiveSite, type SnapshotRow } from './public-sites.service.js';

/** Bumped when any file's shape changes, so every cached ETag goes stale. */
const SITE_FILES_FORMAT_VERSION = 1;

export interface SiteFileQuery {
  slug?: string;
  host?: string;
  /** A version's slug; omitted = the default version. */
  version?: string;
}

/** A small file, whole. `body` is null when the caller's ETag still matches. */
export interface SiteFile {
  etag: string;
  body: string | null;
}

/** llms-full.txt is streamed: the plan, then pages written one at a time. */
export interface SiteFullPlan {
  etag: string;
  header: string;
  pages: { documentId: string; revisionId: string; title: string; url: string }[];
}

interface TextSink {
  write(chunk: string): unknown;
}

/**
 * The machine-readable files of a published site (docs/features/44, issue #77
 * phase 2b): `sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt` and a
 * page as markdown.
 *
 * Generated per request from the version's snapshot rows — the same rows the
 * reader renders — so they can name nothing the site does not publish, and
 * they change exactly when a build swaps the snapshot. Nothing is stored:
 * a request with a current ETag costs the site lookup and one row read.
 *
 * Every URL is absolute against the site's canonical root (its first verified
 * domain, else its subdomain or path), and every page URL is the one the
 * reader serves it at, home rule included.
 *
 * Public pages only, whoever asks (issue #77 phase 3): these files are for
 * crawlers and agents and never vary by cookie. A page kept to members or
 * visitors is left out, and its `.md` is a 404. Since a rule change restamps
 * rows without a build, the restricted ids are part of every ETag here.
 */
@Injectable()
export class PublicSiteFilesService {
  private readonly logger = new Logger(PublicSiteFilesService.name);

  constructor(
    private readonly sites: PublicSitesService,
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * The default version's pages, for search engines. Older versions are left
   * out on purpose: they would compete with the current one for the same
   * query, which is also why their pages say noindex. A site that asked not to
   * be indexed has no sitemap.
   */
  async sitemap(query: SiteFileQuery, ifNoneMatch?: string): Promise<SiteFile> {
    const site = await this.sites.find(query);
    if (!site.seoIndexable) throw this.notFound();
    const version = site.defaultVersion;
    const root = this.sites.rootUrl(site);
    const etag = this.etag('sitemap', site, version, [root, await this.restricted(version.id)]);
    if (matches(ifNoneMatch, etag)) return { etag, body: null };

    const rows = await this.rows(version.id);
    const homeId = siteHomeDocumentId(rows);
    const finalized = new Map(
      (
        await this.prisma.documentRevision.findMany({
          where: { id: { in: rows.map((r) => r.revisionId) } },
          select: { id: true, finalizedAt: true },
        })
      ).map((r) => [r.id, r.finalizedAt]),
    );
    const urls = this.ordered(rows).map((r) => {
      const loc = `${root}${sitePagePath('', null, r.documentId === homeId ? '' : r.slugPath)}`;
      const lastmod = finalized.get(r.revisionId);
      return `  <url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}</url>`;
    });
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls,
      '</urlset>',
      '',
    ].join('\n');
    return { etag, body };
  }

  /** Everything allowed with a sitemap, or everything disallowed when the site asked not to be indexed. */
  async robots(query: SiteFileQuery, ifNoneMatch?: string): Promise<SiteFile> {
    const site = await this.sites.find(query);
    const root = this.sites.rootUrl(site);
    const etag = this.etag('robots', site, site.defaultVersion, [root, site.seoIndexable]);
    if (matches(ifNoneMatch, etag)) return { etag, body: null };
    const body = site.seoIndexable
      ? `User-agent: *\nAllow: /\n\nSitemap: ${root}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n';
    return { etag, body };
  }

  /** The llmstxt.org index of one version: its pages as markdown links, in reading order, then the other versions. */
  async llmsIndex(query: SiteFileQuery, ifNoneMatch?: string): Promise<SiteFile> {
    const site = await this.sites.find(query);
    const version = this.version(site, query.version);
    const root = this.sites.rootUrl(site);
    const title = await this.title(site);
    const others = site.versions.filter((v) => v.id !== version.id);
    const etag = this.etag('llms', site, version, [
      root,
      title,
      others.map((v) => [v.id, v.slug, v.name]),
      await this.restricted(version.id),
    ]);
    if (matches(ifNoneMatch, etag)) return { etag, body: null };

    const rows = await this.rows(version.id);
    const versionSlug = this.segment(site, version);
    const prefix = versionSlug ? `${root}/${encodeURIComponent(versionSlug)}` : root;
    const body = renderLlmsIndex({
      title,
      blurb: `${title} documentation (${version.name}), as published. Each link is the page as markdown.`,
      fullUrl: `${prefix}/llms-full.txt`,
      sections: [
        { heading: 'Pages', pages: this.ordered(rows).map((r) => ({ id: r.documentId, title: r.title, category: '', depth: r.depth, url: `${root}${siteMarkdownPath('', versionSlug, r.slugPath)}` })) },
        {
          heading: 'Other versions',
          pages: others.map((v) => {
            const slug = this.segment(site, v);
            return { id: v.id, title: v.name, category: '', depth: 0, url: `${slug ? `${root}/${encodeURIComponent(slug)}` : root}/llms.txt` };
          }),
        },
      ],
    });
    return { etag, body };
  }

  /** The plan for llms-full.txt: every page of the version at its pinned revision, in reading order. */
  async llmsFullPlan(query: SiteFileQuery): Promise<SiteFullPlan> {
    const site = await this.sites.find(query);
    const version = this.version(site, query.version);
    const root = this.sites.rootUrl(site);
    const title = await this.title(site);
    const caps = [this.config.get('LLMS_FULL_MAX_DOCS', { infer: true }), this.config.get('LLMS_FULL_MAX_BYTES', { infer: true })];
    const rows = await this.rows(version.id);
    const homeId = siteHomeDocumentId(rows);
    const versionSlug = this.segment(site, version);
    const prefix = versionSlug ? `${root}/${encodeURIComponent(versionSlug)}` : root;
    return {
      etag: this.etag('llms-full', site, version, [root, title, caps, await this.restricted(version.id)]),
      header: renderFullHeader({ title, indexUrl: `${prefix}/llms.txt` }),
      pages: this.ordered(rows).map((r) => ({
        documentId: r.documentId,
        revisionId: r.revisionId,
        title: r.title,
        url: `${root}${sitePagePath('', versionSlug, r.documentId === homeId ? '' : r.slugPath)}`,
      })),
    };
  }

  /**
   * Write the plan page by page, never buffered, under the same caps as the
   * workspace dumps (LLMS_FULL_MAX_DOCS / _BYTES). The status is already sent,
   * so nothing here throws: an unreadable page is a marker, a cap is a marker.
   */
  async streamFull(plan: SiteFullPlan, out: TextSink): Promise<void> {
    const maxDocs = this.config.get('LLMS_FULL_MAX_DOCS', { infer: true });
    const maxBytes = this.config.get('LLMS_FULL_MAX_BYTES', { infer: true });
    const window = Math.max(1, Number(this.config.get('AI_READABLE_FETCH_CONCURRENCY') ?? 8));
    out.write(plan.header);
    let bytes = 0;
    let written = 0;
    let i = 0;
    outer: while (i < plan.pages.length) {
      const batch = plan.pages.slice(i, i + window);
      const bodies = await Promise.all(
        batch.map((p) =>
          this.documents.getContent(p.documentId, p.revisionId).then(
            (c) => c.markdown,
            (e: unknown) => {
              this.logger.warn(`site llms-full: page ${p.documentId} unavailable: ${(e as Error).message}`);
              return null;
            },
          ),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        if (written >= maxDocs) break outer;
        const page = batch[j];
        const body = bodies[j];
        const chunk = body === null ? unavailableMarker(page.documentId) : `${renderFullPage({ title: page.title, body, url: page.url })}\n`;
        const size = Buffer.byteLength(chunk);
        if (bytes + size > maxBytes) break outer;
        out.write(chunk);
        bytes += size;
        if (body !== null) written++;
        i++;
      }
    }
    if (i < plan.pages.length) out.write(truncatedMarker(plan.pages.length - i, []));
  }

  /**
   * One page as markdown, at the revision its version pinned. `path` is the
   * page's path below the site root without `.md`: `guides/install`,
   * `v1/guides/install`, or `index` / `v1/index` for a version's home.
   */
  async markdown(query: SiteFileQuery & { path?: string }, ifNoneMatch?: string): Promise<SiteFile> {
    const site = await this.sites.find(query);
    const { version, slugPath } = this.sites.splitPath(site, query.path ?? '');
    const rows = await this.rows(version.id);
    let row = rows.find((r) => r.slugPath === slugPath);
    if (!row && (slugPath === 'index' || slugPath.endsWith('/index'))) {
      const parent = slugPath.slice(0, -'index'.length).replace(/\/$/, '');
      const homeId = siteHomeDocumentId(rows);
      row = parent ? rows.find((r) => r.slugPath === parent) : rows.find((r) => r.documentId === homeId);
    }
    if (!row) throw this.notFound();
    const etag = quote(hash([SITE_FILES_FORMAT_VERSION, 'md', row.revisionId, row.title]));
    if (matches(ifNoneMatch, etag)) return { etag, body: null };
    const content = await this.documents.getContent(row.documentId, row.revisionId).catch(() => null);
    if (!content) throw this.notFound();
    return { etag, body: `${titledMarkdown(row.title, content.markdown).trimEnd()}\n` };
  }

  // -------------------------------------------------------------------------

  private notFound(): NotFoundException {
    return new NotFoundException(t('error.site.notFound'));
  }

  private version(site: LiveSite, slug: string | undefined) {
    if (!slug) return site.defaultVersion;
    const version = site.versions.find((v) => v.slug === slug);
    if (!version) throw this.notFound();
    return version;
  }

  /** A version's URL segment; the default version has none. */
  private segment(site: LiveSite, version: SiteVersion): string | null {
    return version.id === site.defaultVersionId ? null : version.slug;
  }

  /** The version's public rows. A public stamp folds down from public ancestors, so no row here hangs from a hidden one. */
  private rows(versionId: string): Promise<SnapshotRow[]> {
    return this.prisma.siteVersionPage.findMany({
      where: { versionId, audience: 'public' },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
      select: SNAPSHOT_ROW,
    });
  }

  /** Reading order: depth-first, siblings by position then title — the order of the reader's nav. */
  private ordered(rows: SnapshotRow[]): SnapshotRow[] {
    const byId = new Map(rows.map((r) => [r.documentId, r]));
    return orderPages(
      rows.map((r) => ({
        id: r.documentId,
        title: r.title,
        category: '',
        parentId: r.parentId,
        position: r.position,
        projectId: '',
        headRevisionId: r.revisionId,
        s3Key: '',
      })),
    ).map((p) => ({ ...byId.get(p.id)!, depth: p.depth }));
  }

  /** Ids of the version's pages kept from the public, sorted: what a restamp can change without a build. */
  private async restricted(versionId: string): Promise<string[]> {
    const rows = await this.prisma.siteVersionPage.findMany({
      where: { versionId, audience: { not: 'public' } },
      select: { documentId: true },
      orderBy: { documentId: 'asc' },
    });
    return rows.map((r) => r.documentId);
  }

  private async title(site: LiveSite): Promise<string> {
    const project = await this.prisma.project.findUnique({ where: { id: site.projectId }, select: { name: true } });
    return project?.name ?? site.slug;
  }

  /** A version's snapshot changes only when a build stamps `built_at`; with that, the inputs name every byte. */
  private etag(kind: string, site: LiveSite, version: SiteVersion, extra: unknown[]): string {
    return quote(hash([SITE_FILES_FORMAT_VERSION, kind, site.id, version.id, version.builtAt?.toISOString() ?? null, extra]));
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function quote(h: string): string {
  return `"${h}"`;
}

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}
