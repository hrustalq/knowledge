import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ProfileOpenWork,
  ProfilePage,
  RevisionStatus,
  UserProfileResponse,
  WorkspaceRole,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { DEV_ACTOR_ID } from '../activity/activity.service.js';

/** Pages listed inline on a profile; the count beside them is not capped. */
const PAGE_LIMIT = 12;

/**
 * One workspace member, read as a work record.
 *
 * Everything here is derived — there is no profile table, and there must not
 * be one: a second copy of "how many pages has this person written" is a copy
 * that goes stale the first time a revision is finalized. The cost is a
 * handful of counts per view, which is what an infrequently-visited page can
 * afford.
 */
@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(principal: Principal, workspaceId: string, userId: string): Promise<UserProfileResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { apiKeys: { where: { revokedAt: null }, select: { id: true }, take: 1 } },
    });
    // AUTH_MODE=none has no users row — DEV_PRINCIPAL is synthetic, which is
    // the point. Without this the default development mode 404s on its own
    // profile, so the one link the avatar menu always shows would dead-end.
    // Same accommodation `requireRole` and the merge gate already make for it.
    if (!user && userId === DEV_ACTOR_ID && principal.mode === 'dev') {
      return this.devProfile(principal, workspaceId);
    }
    if (!user) throw new NotFoundException(t('error.user.notFound', { id: userId }));

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });

    const [pages, pageCount, openWork] = await Promise.all([
      this.pagesFor(workspaceId, userId),
      this.pageCountFor(workspaceId, userId),
      this.openWorkFor(workspaceId, userId),
    ]);

    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: userAvatarUrl(user),
      isAdmin: user.isAdmin,
      disabled: user.disabledAt !== null,
      createdAt: user.createdAt.toISOString(),
      role: (membership?.role as WorkspaceRole | undefined) ?? null,
      trustedOperator: membership?.trustedOperator ?? false,
      memberSince: membership?.createdAt.toISOString() ?? null,
      isSelf: principal.userId === userId,
      hasPassword: user.passwordHash !== null,
      hasApiKey: user.apiKeys.length > 0,
      pages,
      pageCount,
      openWork,
    };
  }

  /**
   * Pages they have revised, newest touch first.
   *
   * Grouped over revisions rather than read off documents because a document
   * has no author column — authorship in this product is a property of the
   * revision that made it, which is also what makes "authored" (revision 1 is
   * theirs) distinguishable from "revised".
   */
  private async pagesFor(workspaceId: string, userId: string): Promise<ProfilePage[]> {
    const revisions = await this.prisma.documentRevision.findMany({
      where: { authorId: userId, document: { workspaceId } },
      select: {
        documentId: true,
        revisionNumber: true,
        createdAt: true,
        document: { select: { id: true, title: true, category: true, projectId: true } },
      },
      orderBy: { createdAt: 'desc' },
      // Enough rows to fill PAGE_LIMIT distinct documents for a prolific
      // author without paging: revisions cluster heavily per document.
      take: 400,
    });

    const byDocument = new Map<string, ProfilePage>();
    for (const revision of revisions) {
      const existing = byDocument.get(revision.documentId);
      if (existing) {
        existing.revisions += 1;
        existing.authored ||= revision.revisionNumber === 1;
        continue;
      }
      if (byDocument.size >= PAGE_LIMIT) continue;
      byDocument.set(revision.documentId, {
        documentId: revision.documentId,
        title: revision.document.title,
        category: revision.document.category,
        projectId: revision.document.projectId,
        status: null,
        authored: revision.revisionNumber === 1,
        revisions: 1,
        lastTouchedAt: revision.createdAt.toISOString(),
      });
    }

    const pages = [...byDocument.values()];
    await this.attachHeadStatus(pages);
    return pages;
  }

  /** Head-revision status per page, for the lifecycle dot (one query, not N). */
  private async attachHeadStatus(pages: ProfilePage[]): Promise<void> {
    if (pages.length === 0) return;
    const heads = await this.prisma.documentRevision.findMany({
      where: { documentId: { in: pages.map((p) => p.documentId) } },
      select: { documentId: true, status: true, revisionNumber: true },
      orderBy: { revisionNumber: 'desc' },
    });
    const seen = new Set<string>();
    const statusByDocument = new Map<string, RevisionStatus>();
    for (const head of heads) {
      if (seen.has(head.documentId)) continue;
      seen.add(head.documentId);
      statusByDocument.set(head.documentId, head.status as RevisionStatus);
    }
    for (const page of pages) page.status = statusByDocument.get(page.documentId) ?? null;
  }

  private async pageCountFor(workspaceId: string, userId: string): Promise<number> {
    const distinct = await this.prisma.documentRevision.findMany({
      where: { authorId: userId, document: { workspaceId } },
      select: { documentId: true },
      distinct: ['documentId'],
    });
    return distinct.length;
  }

  /**
   * What is still owed. Every number here is a link the profile can offer, so
   * a zero is as informative as a five — "nothing open" is the answer someone
   * came for as often as its opposite.
   */
  private async openWorkFor(workspaceId: string, userId: string): Promise<ProfileOpenWork> {
    const inWorkspace = { document: { workspaceId } } as const;

    const [authoredMergeRequests, reviewing, threadIds] = await Promise.all([
      this.prisma.mergeRequest.count({ where: { ...inWorkspace, authorId: userId, status: 'open' } }),
      this.prisma.mergeRequest.findMany({
        where: { ...inWorkspace, status: 'open', reviewers: { some: { userId } } },
        select: { id: true, approvedBy: true },
      }),
      this.prisma.documentComment.findMany({
        where: { authorId: userId, thread: inWorkspace },
        select: { threadId: true },
        distinct: ['threadId'],
      }),
    ]);

    // `approved_by` is a Json array of author ids (Phase 3), so the filter is
    // in Node — a request for review they have already answered is not owed.
    const awaitingTheirReview = reviewing.filter(
      (mr) => !(Array.isArray(mr.approvedBy) ? (mr.approvedBy as unknown[]) : []).includes(userId),
    ).length;

    const unresolvedThreads =
      threadIds.length === 0
        ? 0
        : await this.prisma.documentThread.count({
            where: { id: { in: threadIds.map((t) => t.threadId) }, resolved: false, resolvable: true },
          });

    return { authoredMergeRequests, awaitingTheirReview, unresolvedThreads };
  }

  /**
   * The dev principal, rendered as a profile. Its work IS real — it authored
   * every revision in a development workspace — so the pages and open-work
   * queries run normally against the stub id; only the identity half is
   * synthesized, because there is no row to read it from.
   */
  private async devProfile(principal: Principal, workspaceId: string): Promise<UserProfileResponse> {
    const [pages, pageCount, openWork] = await Promise.all([
      this.pagesFor(workspaceId, DEV_ACTOR_ID),
      this.pageCountFor(workspaceId, DEV_ACTOR_ID),
      this.openWorkFor(workspaceId, DEV_ACTOR_ID),
    ]);
    return {
      userId: DEV_ACTOR_ID,
      email: principal.email,
      displayName: principal.displayName,
      // No users row, so no avatar to have. The initials face is what the dev
      // principal has always shown, and it stays correct.
      avatarUrl: null,
      isAdmin: true,
      disabled: false,
      // No account was ever created, so the honest answer is the oldest thing
      // this identity did here rather than an invented sign-up date.
      createdAt: pages[pages.length - 1]?.lastTouchedAt ?? new Date().toISOString(),
      role: 'admin',
      trustedOperator: true,
      memberSince: null,
      isSelf: true,
      hasPassword: false,
      hasApiKey: false,
      pages,
      pageCount,
      openWork,
    };
  }
}
