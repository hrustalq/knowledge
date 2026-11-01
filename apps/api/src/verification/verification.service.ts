import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Document } from '@prisma/client';
import type {
  ArchiveDocumentResponse,
  DocumentDetailResponse,
  VerificationFlag,
  VerificationSource,
} from '@knowledge/contracts';
import { VERIFICATION_NOTE_MAX_CHARS } from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import { DocumentsService, subtreeWhere } from '../documents/documents.service.js';
import { sourceConnectorOf } from '../documents/source-backed.js';
import { t } from '../i18n/t.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectCommitsService } from '../git/project-commits.service.js';
import { expiryFor, VerificationPolicyService } from './verification-policy.service.js';

/** `details.reason` on the 409s this service raises, so a bulk caller can file them without parsing text. */
export const VERIFICATION_CONFLICTS = {
  archived: 'document_archived',
  noHead: 'no_head_revision',
  sourceBacked: 'source_backed',
} as const;

export interface FlagOptions {
  actorId: string;
  note?: string | null;
  /** Defaults to the acting person. Agents pass `drift` / `curator` / `mcp` with their run or PR. */
  source?: Omit<VerificationSource, 'at'> & { at?: string };
  /**
   * Leave the page alone when it was verified at or after this moment — a
   * finding computed against an older head must not undo a newer check.
   */
  unlessVerifiedAfter?: Date;
  /** Leave an `outdated` page alone rather than downgrading it to `requested`. */
  keepOutdated?: boolean;
  /**
   * Act only when the page currently carries this flag. The sentinel turns a
   * `requested` it set into `outdated` when the pull request merges — never a
   * page somebody has since cleared.
   */
  onlyIfFlag?: VerificationFlag;
}

/**
 * The verification state machine (docs/features/39, issue #66), one place.
 *
 * What is stored is small: the stamp (`verified_*`, `verification_expires_at`)
 * and at most one declared flag with its note and source. Everything a reader
 * sees is `verificationStateFor` over those plus the head and the open-report
 * count — so this service only ever writes, and every write is a **single
 * guarded statement** (`updateMany` over `{ id, archivedAt: null }`) followed by
 * one activity record. A second replica racing on the same page loses the
 * `updateMany` and records nothing.
 *
 * Verifying is a person's act: it has no agent caller by design, and the MCP
 * surface exposes only the two flags (`knowledge_flag_document`). Archive is a
 * visibility default, not an access boundary — a viewer can still open an
 * archived page by id, and that is documented, not accidental.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly policy: VerificationPolicyService,
    private readonly documents: DocumentsService,
    private readonly commits: ProjectCommitsService,
  ) {}

  /**
   * Stamp the page as checked at its current head. Clears any flag and both
   * sweeper stamps, and computes the expiry from the page's own interval (set
   * here when given) or the workspace default. Refused on an archived page or
   * one with no finalized head — there is nothing to vouch for.
   */
  async verify(
    documentId: string,
    actorId: string,
    opts: { intervalDays?: number | null } = {},
  ): Promise<DocumentDetailResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: { select: { name: true, headRevisionId: true } } },
    });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    this.assertNotArchived(document);
    // #674: a source-backed page's trust is its sync's health; nobody stamps it.
    if (await sourceConnectorOf(this.prisma, documentId)) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.sourceVerify', { title: document.title }),
        reason: VERIFICATION_CONFLICTS.sourceBacked,
      });
    }
    const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
    if (!headId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.noRevisions', { id: documentId }),
        reason: VERIFICATION_CONFLICTS.noHead,
      });
    }
    const interval = opts.intervalDays !== undefined ? opts.intervalDays : document.reviewIntervalDays;
    const settings = await this.policy.effective(document.workspaceId);
    const verifiedAt = new Date();
    const expiresAt = expiryFor(verifiedAt, interval, settings.reviewIntervalDays);

    const { count } = await this.prisma.document.updateMany({
      where: { id: documentId, archivedAt: null },
      data: {
        verifiedAt,
        verifiedBy: actorId,
        verifiedRevisionId: headId,
        verificationExpiresAt: expiresAt,
        ...(opts.intervalDays !== undefined ? { reviewIntervalDays: opts.intervalDays } : {}),
        verificationFlag: null,
        verificationNote: null,
        verificationSource: { kind: 'person', by: actorId, at: verifiedAt.toISOString() },
        expiryRemindedAt: null,
        expiredNotifiedAt: null,
      },
    });
    if (count === 0) this.assertNotArchived(await this.row(documentId));

    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.verified',
      documentId,
      projectId: document.projectId,
      subjectId: headId,
      metadata: { title: document.title, revisionId: headId, expiresAt: expiresAt?.toISOString() ?? null },
      patch: {
        verifiedAt: verifiedAt.toISOString(),
        verifiedBy: actorId,
        verifiedRevisionId: headId,
        verificationExpiresAt: expiresAt?.toISOString() ?? null,
        verificationFlag: null,
        verification: 'verified',
      },
    });
    return this.documents.getDocument(documentId);
  }

  /** Any member may ask for a check (`viewer`, like a comment). Tells the owner. */
  requestVerification(documentId: string, opts: FlagOptions): Promise<DocumentDetailResponse | null> {
    return this.flag(documentId, 'requested', opts);
  }

  /** Declare the page wrong (`editor`). Tells the owner. */
  markOutdated(documentId: string, opts: FlagOptions): Promise<DocumentDetailResponse | null> {
    return this.flag(documentId, 'outdated', opts);
  }

  /**
   * Set the declared flag. Returns `null` when one of the "unless" guards left
   * the page alone, so an agent caller can count skips without a second read.
   */
  async flag(documentId: string, flag: VerificationFlag, opts: FlagOptions): Promise<DocumentDetailResponse | null> {
    const document = await this.row(documentId);
    this.assertNotArchived(document);
    if (opts.unlessVerifiedAfter && document.verifiedAt && document.verifiedAt >= opts.unlessVerifiedAfter) return null;
    if (opts.keepOutdated && document.verificationFlag === 'outdated') return null;
    if (opts.onlyIfFlag && document.verificationFlag !== opts.onlyIfFlag) return null;

    const at = new Date();
    const note = opts.note?.slice(0, VERIFICATION_NOTE_MAX_CHARS) ?? null;
    const source: VerificationSource = {
      kind: 'person',
      by: opts.actorId,
      ...opts.source,
      at: opts.source?.at ?? at.toISOString(),
    };
    const { count } = await this.prisma.document.updateMany({
      where: { id: documentId, archivedAt: null },
      data: { verificationFlag: flag, verificationNote: note, verificationSource: { ...source } },
    });
    if (count === 0) this.assertNotArchived(await this.row(documentId));

    const action = flag === 'outdated' ? 'document.outdated' : 'document.verification-requested';
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: opts.actorId,
      action,
      documentId,
      projectId: document.projectId,
      metadata: { title: document.title, note, source },
      patch: { verificationFlag: flag, verificationNote: note, verification: flag },
    });
    // The owner hears directly (reason `owner`, category `verification`); a
    // watcher hears through the fan-out that `record` already triggered. The
    // actor is never told about their own act.
    const owner = document.ownerId ?? document.verifiedBy;
    if (owner && owner !== opts.actorId) {
      void this.notifications.notify({
        workspaceId: document.workspaceId,
        userIds: [owner],
        type: action,
        reason: 'owner',
        actor: opts.actorId,
        documentId,
        subjectType: 'document',
        subjectId: documentId,
        title: document.title,
        metadata: { note, source: source.kind },
      });
    }
    return this.documents.getDocument(documentId);
  }

  /**
   * Back to `unverified`: the stamp and the flag both go. Idempotent — a page
   * with neither records nothing. Which event is written says what was there:
   * a flag makes it `verification-cleared`, a bare stamp `unverified`.
   */
  async clear(documentId: string, actorId: string): Promise<DocumentDetailResponse> {
    const document = await this.row(documentId);
    this.assertNotArchived(document);
    const hadFlag = !!document.verificationFlag;
    const hadStamp = !!document.verifiedRevisionId;
    if (!hadFlag && !hadStamp) return this.documents.getDocument(documentId);

    await this.prisma.document.updateMany({
      where: { id: documentId, archivedAt: null },
      data: {
        verifiedAt: null,
        verifiedBy: null,
        verifiedRevisionId: null,
        verificationExpiresAt: null,
        verificationFlag: null,
        verificationNote: null,
        verificationSource: Prisma.DbNull,
        expiryRemindedAt: null,
        expiredNotifiedAt: null,
      },
    });
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: hadFlag ? 'document.verification-cleared' : 'document.unverified',
      documentId,
      projectId: document.projectId,
      metadata: { title: document.title },
      patch: { verifiedAt: null, verifiedBy: null, verifiedRevisionId: null, verificationFlag: null, verification: 'unverified' },
    });
    return this.documents.getDocument(documentId);
  }

  /**
   * Drop the declared flag and nothing else (#424): the stamp stays, so this is
   * never a verification. What a tracker close may do for a mapped editor. One
   * guarded statement; a page with no flag records nothing.
   */
  async clearFlag(documentId: string, actorId: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
    const document = await this.row(documentId);
    const { count } = await this.prisma.document.updateMany({
      where: { id: documentId, archivedAt: null, verificationFlag: { not: null } },
      data: { verificationFlag: null, verificationNote: null, verificationSource: Prisma.DbNull },
    });
    if (!count) return false;
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.verification-cleared',
      documentId,
      projectId: document.projectId,
      metadata: { title: document.title, ...metadata },
      patch: { verificationFlag: null },
    });
    return true;
  }

  /**
   * Archive the page and, by default, everything under it — one statement over
   * `path LIKE '<own path>%'`, which the (workspace_id, path) index serves and
   * which is what stops a parent being archived over live children. Idempotent
   * on an archived page.
   */
  async archive(documentId: string, actorId: string, includeDescendants = true): Promise<ArchiveDocumentResponse> {
    const document = await this.row(documentId);
    if (document.archivedAt) return { documentId, archivedAt: document.archivedAt.toISOString(), affected: 0 };
    const archivedAt = new Date();
    const count = await this.setArchived(document, includeDescendants, { archivedAt, archivedBy: actorId }, actorId);
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.archived',
      documentId,
      projectId: document.projectId,
      metadata: { title: document.title, affected: count, includeDescendants },
      patch: { archivedAt: archivedAt.toISOString(), archivedBy: actorId },
    });
    return { documentId, archivedAt: archivedAt.toISOString(), affected: count };
  }

  /** The inverse, same statement shape. Restores the subtree by default. */
  async unarchive(documentId: string, actorId: string, includeDescendants = true): Promise<ArchiveDocumentResponse> {
    const document = await this.row(documentId);
    if (!document.archivedAt) return { documentId, archivedAt: null, affected: 0 };
    const count = await this.setArchived(document, includeDescendants, { archivedAt: null, archivedBy: null }, actorId);
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.unarchived',
      documentId,
      projectId: document.projectId,
      metadata: { title: document.title, affected: count, includeDescendants },
      patch: { archivedAt: null, archivedBy: null },
    });
    return { documentId, archivedAt: null, affected: count };
  }

  /**
   * Flip the archive stamp on the page (and its subtree) where it differs, and
   * record the pages it flipped as one project commit (#636): an archive takes
   * them out of the git tree, an unarchive puts them back.
   */
  private async setArchived(
    document: Document,
    includeDescendants: boolean,
    data: { archivedAt: Date | null; archivedBy: string | null },
    actorId: string,
  ): Promise<number> {
    return this.prisma.withTransaction(async () => {
      await this.commits.lock(document.projectId);
      const rows = await this.prisma.document.findMany({
        where: { ...subtreeWhere(document, includeDescendants), archivedAt: data.archivedAt ? null : { not: null } },
        select: { id: true },
      });
      const ids = rows.map((r) => r.id);
      await this.prisma.document.updateMany({ where: { id: { in: ids } }, data });
      const verb = data.archivedAt ? 'Archive' : 'Unarchive';
      await this.commits.recordState(document.projectId, ids, { actorId, message: `${verb} ${document.slug ?? document.title}` });
      return ids.length;
    });
  }


  private async row(documentId: string): Promise<Document> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    return doc;
  }

  private assertNotArchived(document: Document): void {
    if (document.archivedAt) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.archived', { id: document.id }),
        reason: VERIFICATION_CONFLICTS.archived,
      });
    }
  }
}
