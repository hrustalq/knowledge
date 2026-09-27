import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsService } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { parseMarkdown } from '../common/frontmatter.js';
import { t } from '../i18n/t.js';
import { type AiReadableScope, isReadableRevisionStatus, readableDocumentsWhere } from './ai-readable-scope.js';
import { AI_READABLE_FORMAT_VERSION, etagFor, etagMatches, renderPageMarkdown } from './render.js';
import {
  type IndexPage,
  type OrderedPage,
  orderPages,
  renderFullHeader,
  renderFullPage,
  renderLlmsIndex,
  truncatedMarker,
  unavailableMarker,
} from './llms.js';

export type TextResult = { status: 304; etag: string } | { status: 200; etag: string; body: string };

/** Everything `llms-full.txt` needs before its first byte, resolved from PG alone. */
export interface FullPlan {
  etag: string;
  header: string;
  pages: OrderedPage[];
  /** Per-project full-text URLs, named in the truncation marker of a workspace dump. */
  narrower: string[];
}

export interface FullStats {
  pages: number;
  bytes: number;
  truncated: number;
  unavailable: number;
}

/** The subset of an express Response the streamer writes to. */
export interface TextSink {
  write(chunk: string): unknown;
}

export type PageMarkdownResult =
  | { status: 304; etag: string }
  | { status: 200; etag: string; body: string; llmsIndexUrl: string };

/**
 * AI-readable output (issue #68): the plain-HTTP, plain-markdown layer over the
 * versioned store. Everything is derived at read time from PG + S3 — no stored
 * copy, no regeneration job; freshness is the ETag.
 *
 * Controller-free so the MCP server (phase 5) can serve byte-identical resources.
 */
@Injectable()
export class AiReadableService {
  private readonly logger = new Logger(AiReadableService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly config: ConfigService,
    // Optional so the single-page path (phase 1) needs no storage of its own:
    // it reads through DocumentsService. The listings stream bodies directly.
    @Optional() private readonly storage?: StorageService,
  ) {}

  /** Kill switch for every route of the feature (`AI_READABLE_ENABLED`). */
  enabled(): boolean {
    return this.config.get<boolean>('AI_READABLE_ENABLED') !== false;
  }

  assertEnabled(): void {
    if (!this.enabled()) throw new NotFoundException();
  }

  /**
   * One page as markdown. The revision and its metadata are resolved from PG
   * first so a matching `If-None-Match` answers 304 without touching S3.
   */
  async pageMarkdown(
    documentId: string,
    opts: { revisionId?: string; frontmatter: boolean; ifNoneMatch?: string },
  ): Promise<PageMarkdownResult> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId },
      include: { branches: true, project: { select: { name: true } } },
    });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    // Belt and braces: the predicate is the single definition of "exported",
    // so the page read runs through it like the listings will.
    const inScope = await this.prisma.document.count({
      where: readableDocumentsWhere({ workspaceId: document.workspaceId, documentId }),
    });
    if (inScope === 0) throw new NotFoundException(t('error.document.notFound', { id: documentId }));

    const revisionId =
      opts.revisionId ?? document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? undefined;
    const revision = revisionId ? await this.prisma.documentRevision.findUnique({ where: { id: revisionId } }) : null;
    if (!revision || revision.documentId !== documentId) {
      if (opts.revisionId) {
        throw new NotFoundException(
          t('error.revision.notFoundOnDocument', { revisionId: opts.revisionId, documentId }),
        );
      }
      throw new NotFoundException(t('error.document.noReadableRevision', { id: documentId }));
    }
    if (!isReadableRevisionStatus(revision.status)) {
      throw new BadRequestException(t('error.document.contentIsDraft', { id: revision.id }));
    }

    const etag = etagFor({
      revisionId: revision.id,
      title: document.title,
      project: document.project.name,
      frontmatter: opts.frontmatter,
    });
    if (etagMatches(opts.ifNoneMatch, etag)) return { status: 304, etag };

    const content = await this.documents.getContent(documentId, revision.id);
    const webBase = this.webBase();
    const body = renderPageMarkdown(
      { title: document.title, body: content.markdown, frontmatter: content.frontmatter },
      {
        documentId,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        project: document.project.name,
        url: `${webBase}/documents/${documentId}`,
        updatedAt: (revision.finalizedAt ?? revision.createdAt).toISOString(),
      },
      { frontmatter: opts.frontmatter },
    );
    return { status: 200, etag, body, llmsIndexUrl: `${webBase}/projects/${document.projectId}/llms.txt` };
  }

  // --- llms.txt / llms-full.txt (phase 2) -----------------------------------

  /**
   * Readable default-branch heads in scope, in PG only. Two queries, whatever
   * the page count: documents through the scope predicate, then their heads.
   * Feature branches and MR sources are never looked at.
   */
  async readablePages(scope: AiReadableScope): Promise<IndexPage[]> {
    const docs = await this.prisma.document.findMany({
      where: readableDocumentsWhere(scope),
      select: {
        id: true,
        title: true,
        category: true,
        parentId: true,
        position: true,
        projectId: true,
        defaultBranch: true,
        branches: { select: { name: true, headRevisionId: true } },
      },
    });
    const headOf = new Map<string, string>();
    for (const d of docs) {
      const head = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId;
      if (head) headOf.set(d.id, head);
    }
    if (headOf.size === 0) return [];
    const heads = await this.prisma.documentRevision.findMany({
      where: { id: { in: [...headOf.values()] } },
      select: { id: true, status: true, s3Key: true },
    });
    const readable = new Map(heads.filter((r) => isReadableRevisionStatus(r.status)).map((r) => [r.id, r]));
    const out: IndexPage[] = [];
    for (const d of docs) {
      const rev = readable.get(headOf.get(d.id) ?? '');
      if (!rev) continue;
      out.push({
        id: d.id,
        title: d.title,
        category: d.category,
        parentId: d.parentId,
        position: d.position,
        projectId: d.projectId,
        headRevisionId: rev.id,
        s3Key: rev.s3Key,
      });
    }
    return out;
  }

  async workspaceIndex(workspaceId: string, ifNoneMatch?: string): Promise<TextResult> {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException();
    const projects = await this.prisma.project.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    const pages = await this.readablePages({ workspaceId });
    const etag = this.listEtag('index', pages, [workspace.name, ...projects.map((p) => `${p.id}:${p.name}`)]);
    if (etagMatches(ifNoneMatch, etag)) return { status: 304, etag };
    const body = renderLlmsIndex({
      title: workspace.name,
      blurb: `Pages in workspace ${workspace.name}, as markdown. Default-branch heads only; send the same Authorization header to fetch each link.`,
      fullUrl: `${this.apiBase()}/v1/workspaces/${workspaceId}/llms-full.txt`,
      sections: projects.map((p) => ({ heading: p.name, pages: this.links(pages.filter((x) => x.projectId === p.id)) })),
    });
    return { status: 200, etag, body };
  }

  async projectIndex(projectId: string, ifNoneMatch?: string): Promise<TextResult> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException();
    const pages = await this.readablePages({ workspaceId: project.workspaceId, projectId });
    const etag = this.listEtag('index', pages, [`${project.id}:${project.name}`]);
    if (etagMatches(ifNoneMatch, etag)) return { status: 304, etag };
    const body = renderLlmsIndex({
      title: project.name,
      blurb: `Pages in project ${project.name}, as markdown. Default-branch heads only; send the same Authorization header to fetch each link.`,
      fullUrl: `${this.apiBase()}/v1/projects/${projectId}/llms-full.txt`,
      sections: [{ heading: 'Pages', pages: this.links(pages) }],
    });
    return { status: 200, etag, body };
  }

  async workspaceFullPlan(workspaceId: string): Promise<FullPlan> {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException();
    const projects = await this.prisma.project.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    const all = await this.readablePages({ workspaceId });
    // Project by project, each in tree order — the same order as the index.
    const pages = projects.flatMap((p) => orderPages(all.filter((x) => x.projectId === p.id)));
    return {
      etag: this.listEtag('full', pages, [workspace.name, ...this.capsKey()]),
      header: renderFullHeader({
        title: workspace.name,
        indexUrl: `${this.apiBase()}/v1/workspaces/${workspaceId}/llms.txt`,
      }),
      pages,
      narrower: projects.map((p) => `${this.apiBase()}/v1/projects/${p.id}/llms-full.txt`),
    };
  }

  async projectFullPlan(projectId: string): Promise<FullPlan & { workspaceId: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException();
    const pages = orderPages(await this.readablePages({ workspaceId: project.workspaceId, projectId }));
    return {
      workspaceId: project.workspaceId,
      etag: this.listEtag('full', pages, [project.name, ...this.capsKey()]),
      header: renderFullHeader({
        title: project.name,
        indexUrl: `${this.apiBase()}/v1/projects/${projectId}/llms.txt`,
      }),
      pages,
      narrower: [],
    };
  }

  /**
   * Write the plan to `out` page by page — never buffered. Bodies are fetched
   * in windows of `AI_READABLE_FETCH_CONCURRENCY` but written in order. The
   * status line is already sent, so nothing here may throw: a failed read is a
   * marker, a cap is a marker, and the stream always ends cleanly.
   */
  async streamFull(plan: FullPlan, out: TextSink): Promise<FullStats> {
    const maxDocs = Number(this.config.get('LLMS_FULL_MAX_DOCS') ?? 2000);
    const maxBytes = Number(this.config.get('LLMS_FULL_MAX_BYTES') ?? 20_000_000);
    const window = Math.max(1, Number(this.config.get('AI_READABLE_FETCH_CONCURRENCY') ?? 8));
    const stats: FullStats = { pages: 0, bytes: 0, truncated: 0, unavailable: 0 };
    out.write(plan.header);

    const pages = plan.pages;
    let i = 0;
    outer: while (i < pages.length) {
      const batch = pages.slice(i, i + window);
      const bodies = await Promise.all(
        batch.map((p) =>
          this.readBody(p.s3Key).catch((e: unknown) => {
            this.logger.warn(`llms-full: page ${p.id} unavailable: ${(e as Error).message}`);
            return null;
          }),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const page = batch[j];
        if (stats.pages >= maxDocs) break outer;
        const body = bodies[j];
        const chunk =
          body === null
            ? unavailableMarker(page.id)
            : `${renderFullPage({ title: page.title, body, url: `${this.webBase()}/documents/${page.id}` })}\n`;
        const size = Buffer.byteLength(chunk);
        if (stats.bytes + size > maxBytes) break outer;
        out.write(chunk);
        stats.bytes += size;
        if (body === null) stats.unavailable++;
        else stats.pages++;
        i++;
      }
    }
    stats.truncated = pages.length - i;
    if (stats.truncated > 0) out.write(truncatedMarker(stats.truncated, plan.narrower));
    return stats;
  }

  /**
   * Workspaces the hub may list, by `knowledge_whoami`'s rule: a pinned key
   * its one workspace, dev / platform admin every workspace, everyone else
   * their memberships. The controller still runs `requireRole` on each.
   */
  async hubCandidates(principal: {
    userId: string;
    mode: string;
    isAdmin: boolean;
    apiKey?: { workspaceId: string | null } | null;
  }): Promise<{ workspaceId: string; name: string; projects: { projectId: string; name: string }[] }[]> {
    const pinned = principal.apiKey?.workspaceId ?? null;
    const seesAll = principal.mode === 'dev' || principal.isAdmin;
    const ids = pinned
      ? [pinned]
      : seesAll
        ? undefined
        : (await this.prisma.workspaceMember.findMany({ where: { userId: principal.userId } })).map(
            (m) => m.workspaceId,
          );
    const workspaces = await this.prisma.workspace.findMany({
      where: ids ? { id: { in: ids } } : {},
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      workspaces.map(async (w) => {
        const projects = await this.prisma.project.findMany({
          where: { workspaceId: w.id },
          orderBy: { createdAt: 'asc' },
        });
        return { workspaceId: w.id, name: w.name, projects: projects.map((p) => ({ projectId: p.id, name: p.name })) };
      }),
    );
  }

  private async readBody(s3Key: string): Promise<string> {
    if (!this.storage) throw new Error('storage unavailable');
    return parseMarkdown(await this.storage.getObjectText(s3Key)).body;
  }

  private links(pages: IndexPage[]) {
    return orderPages(pages).map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      depth: p.depth,
      url: `${this.webBase()}/documents/${p.id}.md`,
    }));
  }

  /**
   * A listing's validator: every tuple a line of output depends on. Revisions
   * are immutable, so the head id stands for the body — a 304 costs the two PG
   * reads and no S3.
   */
  private listEtag(kind: string, pages: IndexPage[], extra: string[]): string {
    const rows = [...pages]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [p.id, p.headRevisionId, p.title, p.category, p.parentId, p.position, p.projectId]);
    const hash = createHash('sha256')
      .update(JSON.stringify([AI_READABLE_FORMAT_VERSION, kind, this.webBase(), extra, rows]))
      .digest('hex');
    return `"${hash.slice(0, 32)}"`;
  }

  /** Caps change the bytes of a capped dump, so they are part of its validator. */
  private capsKey(): string[] {
    return [String(this.config.get('LLMS_FULL_MAX_DOCS')), String(this.config.get('LLMS_FULL_MAX_BYTES'))];
  }

  apiBase(): string {
    return String(this.config.get<string>('API_PUBLIC_URL') ?? '').replace(/\/+$/, '');
  }

  private webBase(): string {
    return (this.config.get<string>('WEB_BASE_URL') ?? '').replace(/\/+$/, '');
  }
}
