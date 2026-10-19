import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Document, ExportJob, ShareLink } from '@prisma/client';
import type {
  ExportDownloadResponse,
  ExportErrorCode,
  ExportFormat,
  ExportStage,
  ExportStatus,
  PublicShareDownloadOffer,
  PublicShareExport,
  PublicSharePage,
  PublicShareResponse,
  PublicShareTreeNode,
} from '@knowledge/contracts';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { verifyPassword } from '../auth/password.js';
import type { Env } from '../config/env.js';
import { DocumentsService, hasRealPath } from '../documents/documents.service.js';
import { ExportService } from '../export/export.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublishingSettingsService } from '../publishing/publishing-settings.service.js';
import { shareTokenHash } from '../publishing/share-links.service.js';
import { clientIp, PublicRateLimiter, RateLimitedException } from './public-rate-limit.js';
import { ShareUnlockService } from './share-unlock.service.js';

/** `kp_` + 32 bytes base64url. Anything else is a 404 before the database is asked. */
const TOKEN_RE = /^kp_[A-Za-z0-9_-]{43}$/;

/** Most pages a shared subtree lists; deeper levels are cut first (the tree is read breadth-first). */
export const SHARE_TREE_MAX = 500;

type ScopeDocument = Pick<
  Document,
  'id' | 'workspaceId' | 'parentId' | 'title' | 'path' | 'position' | 'archivedAt' | 'restrictedBy'
>;

interface LiveShare {
  share: ShareLink;
  root: ScopeDocument;
}

const SCOPE_SELECT = {
  id: true,
  workspaceId: true,
  parentId: true,
  title: true,
  path: true,
  position: true,
  archivedAt: true,
  restrictedBy: true,
} as const;

/**
 * The anonymous read side of share links (docs/features/43).
 *
 * Every read resolves the link afresh — no authorisation is cached — and then
 * only ever touches documents inside the scope the link names: the page, or
 * its subtree by `documents.path`. A document id or attachment id outside that
 * scope is a 404, indistinguishable from one that does not exist, and so is a
 * link that is unknown, revoked, expired, archived or switched off by its
 * workspace or the deployment. Nothing here serialises a member DTO: the
 * reader gets a title, a body and a tree, never authors, revisions or history.
 */
@Injectable()
export class PublicSharesService {
  private readonly unlockAttempts: number;
  private readonly exportsPerIp: number;
  private readonly exportsPerLink: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PublishingSettingsService,
    private readonly documents: DocumentsService,
    private readonly attachments: AttachmentsService,
    private readonly unlocks: ShareUnlockService,
    private readonly limiter: PublicRateLimiter,
    private readonly exports: ExportService,
    config: ConfigService<Env, true>,
  ) {
    this.unlockAttempts = config.get('PUBLIC_UNLOCK_ATTEMPTS_PER_15MIN', { infer: true });
    this.exportsPerIp = config.get('PUBLIC_EXPORTS_PER_HOUR_PER_IP', { infer: true });
    this.exportsPerLink = config.get('PUBLIC_EXPORTS_PER_HOUR_PER_LINK', { infer: true });
  }

  async view(token: string, cookieHeader: string | undefined): Promise<PublicShareResponse> {
    const live = await this.resolve(token);
    if (!(await this.isOpen(live, cookieHeader))) return { locked: true };
    const { nodes, truncated } = await this.tree(live);
    return {
      locked: false,
      rootDocumentId: live.root.id,
      title: live.root.title,
      includeSubtree: live.share.includeSubtree,
      tree: nodes,
      treeTruncated: truncated,
      expiresAt: live.share.expiresAt?.toISOString() ?? null,
      download: live.share.allowDownload ? this.downloadOffer() : null,
    };
  }

  async page(token: string, documentId: string, cookieHeader: string | undefined): Promise<PublicSharePage> {
    const live = await this.resolveOpen(token, cookieHeader);
    const doc = await this.inScope(live, documentId);
    // The one content path (CLAUDE.md): the same read the app uses, which
    // takes the default-branch head and strips frontmatter. A page with no
    // readable head is as absent here as one outside the scope.
    const content = await this.documents.getContent(doc.id).catch(() => null);
    if (!content) throw this.notFound();
    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: content.revisionId },
      select: { finalizedAt: true },
    });
    return {
      documentId: doc.id,
      title: doc.title,
      markdown: content.markdown,
      updatedAt: revision?.finalizedAt?.toISOString() ?? null,
    };
  }

  /** A presigned URL for an attachment of a page inside the scope. */
  async attachmentUrl(token: string, attachmentId: string, download: boolean, cookieHeader: string | undefined): Promise<string> {
    const live = await this.resolveOpen(token, cookieHeader);
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, documentId: true, status: true },
    });
    if (!attachment || attachment.status !== 'ready') throw this.notFound();
    await this.inScope(live, attachment.documentId);
    return this.attachments.readUrl(attachment.documentId, attachment.id, download);
  }

  /**
   * Export what the link shows (#161), for a reader who may read it: the link
   * live, unlocked and with download on — anything else is the same 404 as a
   * dead link. Counted per address and link and per link before the scope is
   * counted or anything queued, and fail-closed: with the counter down nobody can keep Gotenberg busy.
   */
  async createExport(
    token: string,
    format: ExportFormat,
    req: Parameters<typeof clientIp>[0] & { headers: { cookie?: string } },
  ): Promise<PublicShareExport> {
    const live = await this.resolveDownload(token, req.headers.cookie);
    const hour = 60 * 60_000;
    const allowed =
      (await this.limiter.hit(`share-export:${clientIp(req)}:${live.share.id}`, this.exportsPerIp, hour, false)) &&
      (await this.limiter.hit(`share-export:${live.share.id}`, this.exportsPerLink, hour, false));
    if (!allowed) throw new RateLimitedException(t('error.share.exportRateLimited'), 60 * 60, 'share.exportRateLimited');
    return toPublicExport(await this.exports.createForShareLink(live.share, format));
  }

  /** One of this link's exports — polled while it runs. */
  async getExport(token: string, exportId: string, cookieHeader: string | undefined): Promise<PublicShareExport> {
    const live = await this.resolveDownload(token, cookieHeader);
    return toPublicExport(await this.exports.shareLinkJob(exportId, live.share));
  }

  /** A short-lived URL to the finished file; asked afresh, so a revoke or download switched off ends it at once. */
  async exportDownload(token: string, exportId: string, cookieHeader: string | undefined): Promise<ExportDownloadResponse> {
    const live = await this.resolveDownload(token, cookieHeader);
    return this.exports.shareLinkDownload(exportId, live.share);
  }

  /**
   * Check a password and open a session. Counted per IP and link before the
   * password is even compared, and fail-closed: with the counter down, nobody
   * gets unlimited guesses.
   */
  async unlock(
    token: string,
    password: string,
    req: Parameters<typeof clientIp>[0],
  ): Promise<{ shareId: string; session: string | null; ttlMs: number }> {
    const live = await this.resolve(token);
    const hash = live.share.passwordHash;
    if (!hash) return { shareId: live.share.id, session: null, ttlMs: 0 };
    const allowed = await this.limiter.hit(`unlock:${clientIp(req)}:${live.share.id}`, this.unlockAttempts, 15 * 60_000, false);
    if (!allowed) throw new RateLimitedException(t('error.share.unlockRateLimited'), 15 * 60);
    if (!(await verifyPassword(password, hash))) throw new UnauthorizedException(t('error.share.passwordInvalid'));
    return { shareId: live.share.id, session: await this.unlocks.open(live.share.id, hash), ttlMs: this.unlocks.ttlMs };
  }

  // -------------------------------------------------------------------------

  private notFound(): NotFoundException {
    return new NotFoundException(t('error.share.notFound'));
  }

  /** The link, if it is live right now and its workspace still shares; otherwise 404. */
  private async resolve(token: string): Promise<LiveShare> {
    if (!TOKEN_RE.test(token)) throw this.notFound();
    const share = await this.prisma.shareLink.findUnique({ where: { tokenHash: shareTokenHash(token) } });
    if (!share || share.revokedAt || (share.expiresAt && share.expiresAt.getTime() <= Date.now())) throw this.notFound();
    const settings = await this.settings.effective(share.workspaceId);
    if (!settings.allowShareLinks) throw this.notFound();
    const root = await this.prisma.document.findUnique({ where: { id: share.documentId }, select: SCOPE_SELECT });
    // Restricted since the link was made: the link stops resolving, on the very
    // next request (#76). It is a 404 like any dead link — nothing says why.
    if (!root || root.archivedAt || root.restrictedBy.length > 0) throw this.notFound();
    return { share, root };
  }

  private async isOpen(live: LiveShare, cookieHeader: string | undefined): Promise<boolean> {
    const hash = live.share.passwordHash;
    return !hash || this.unlocks.isUnlocked(live.share.id, hash, cookieHeader);
  }

  private async resolveOpen(token: string, cookieHeader: string | undefined): Promise<LiveShare> {
    const live = await this.resolve(token);
    if (!(await this.isOpen(live, cookieHeader))) throw new UnauthorizedException(t('error.share.locked'));
    return live;
  }

  /** The link, open to this reader, with download on; download off is the same 404 as a dead link. */
  private async resolveDownload(token: string, cookieHeader: string | undefined): Promise<LiveShare> {
    const live = await this.resolveOpen(token, cookieHeader);
    if (!live.share.allowDownload) throw this.notFound();
    return live;
  }

  private downloadOffer(): PublicShareDownloadOffer {
    const { formats, ttlHours } = this.exports.capabilities();
    return { formats, ttlHours };
  }

  /** The document, if the link reaches it. */
  private async inScope(live: LiveShare, documentId: string): Promise<ScopeDocument> {
    if (documentId === live.root.id) return live.root;
    if (!live.share.includeSubtree || !hasRealPath(live.root.path)) throw this.notFound();
    const doc = await this.prisma.document.findUnique({ where: { id: documentId }, select: SCOPE_SELECT });
    if (
      !doc ||
      doc.archivedAt ||
      doc.restrictedBy.length > 0 ||
      doc.workspaceId !== live.root.workspaceId ||
      // Delimited at both ends (CLAUDE.md), so `/a/` never prefix-matches `/ab/`.
      !doc.path.startsWith(live.root.path)
    ) {
      throw this.notFound();
    }
    return doc;
  }

  private async tree(live: LiveShare): Promise<{ nodes: PublicShareTreeNode[]; truncated: boolean }> {
    const rootNode: PublicShareTreeNode = { documentId: live.root.id, parentId: null, title: live.root.title, position: 0 };
    if (!live.share.includeSubtree || !hasRealPath(live.root.path)) return { nodes: [rootNode], truncated: false };
    const rows = await this.prisma.document.findMany({
      where: {
        workspaceId: live.root.workspaceId,
        path: { startsWith: live.root.path },
        archivedAt: null,
        // A restricted page leaves the shared tree, and everything under it
        // with it: its descendants inherit the restriction (#76).
        restrictedBy: { isEmpty: true },
        id: { not: live.root.id },
      },
      select: { id: true, parentId: true, title: true, position: true },
      // Breadth-first: every parent precedes its children, so a cut at the cap
      // never leaves a node whose parent is missing.
      orderBy: [{ depth: 'asc' }, { position: 'asc' }, { title: 'asc' }],
      take: SHARE_TREE_MAX,
    });
    return {
      nodes: [
        rootNode,
        ...rows.map((r) => ({ documentId: r.id, parentId: r.parentId, title: r.title, position: r.position })),
      ],
      truncated: rows.length === SHARE_TREE_MAX,
    };
  }
}

/** What a reader sees of a job: no workspace, page or person id (#161). */
export function toPublicExport(row: ExportJob): PublicShareExport {
  const error = row.error as { code?: string; message?: string } | null;
  return {
    id: row.id,
    format: row.format as ExportFormat,
    status: row.status as ExportStatus,
    stage: (row.stage as ExportStage | null) ?? null,
    pageCount: row.pageCount,
    sizeBytes: row.sizeBytes,
    error: error ? { code: (error.code ?? 'failed') as ExportErrorCode, message: error.message ?? '' } : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}
