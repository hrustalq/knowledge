import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsService } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { isReadableRevisionStatus, readableDocumentsWhere } from './ai-readable-scope.js';
import { etagFor, etagMatches, renderPageMarkdown } from './render.js';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly config: ConfigService,
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

  private webBase(): string {
    return (this.config.get<string>('WEB_BASE_URL') ?? '').replace(/\/+$/, '');
  }
}
