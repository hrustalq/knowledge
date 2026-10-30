import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_API_BREAKING_CHANGE_POLICY, isApiSpecKind } from '@knowledge/contracts';
import type {
  ApiBreakingAck,
  ApiBreakingChangePolicy,
  ApiSpecDiff,
  CreateMergeRequestResponse,
  ListMergeRequestsResponse,
  ListWorkspaceMergeRequestsRequest,
  ListWorkspaceMergeRequestsResponse,
  MergeMergeRequestResponse,
  MergeRequestApiChangesResponse,
  MergeRequestCheckInfo,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestProvenance,
  MergeRequestStatus,
  MergeStrategy,
  PublishBranchResponse,
} from '@knowledge/contracts';
import type { DocumentBranch, MergeRequest, MergeRequestReviewer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRevisionInfo } from './revision-info.js';
import { StorageService } from '../storage/storage.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AccessService } from '../auth/access.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { WORKSPACE_READER, type Principal } from '../auth/principal.js';
import { DOCUMENT_ARCHIVED, DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import type { CreateMergeRequestDto, PublishBranchDto, UpdateMergeRequestDto } from './dto/merge-requests.dto.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { ApiSpecDiffService } from '../api-specs/api-spec-diff.service.js';
import { EntitiesService } from '../entities/entities.service.js';
import { AuditService } from '../auth/audit.service.js';
import { ConflictsService } from '../conflicts/conflicts.service.js';
import { LintChecksService } from './lint/lint-checks.service.js';
import { lintGateEnforced, overridable } from './lint/lint-check.js';
import { ProjectCommitsService } from '../git/project-commits.service.js';
import { sourcePages } from './mr-pages.js';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */
export const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

const MR_INCLUDE = { sourceBranch: true, targetBranch: true, reviewers: true } as const;

type MrWithBranches = MergeRequest & {
  sourceBranch: DocumentBranch;
  targetBranch: DocumentBranch;
  reviewers: MergeRequestReviewer[];
};

/** One page a source branch changes against a target (#636). */
interface MrPage {
  documentId: string;
  source: DocumentBranch & { headRevisionId: string };
  target: DocumentBranch;
  /** Null when the target has no head yet: a page's first merge request. */
  mergeBase: string | null;
}

/**
 * GitLab-style merge requests over the revision DAG (plan.md §8).
 *
 * A merge request spans every page its source branch changed (#636): a branch
 * is its project's, so `sourcePages` derives the set and `documentId` is only
 * the page it was opened from. Every gate runs across the set, and the merge
 * lands every page in one transaction or none.
 *
 * Merging is fast-forward-preconditioned per page: each target head must equal
 * its merge base (i.e. must not have advanced past where we branched),
 * otherwise 409 + comparison link — 3-way content merge is future work.
 * Strategies:
 * - merge-commit → new revision with parents [targetHead, sourceHead]
 * - squash      → new revision parented only on targetHead
 * Either way the merge revision carries the source head's content and goes
 * through the normal finalize → outbox → reindex pipeline.
 *
 * Merge gating: draft MRs never merge; MR_REQUIRED_APPROVALS non-author
 * approvals are required (0 disables); merging into a protected branch
 * requires the workspace admin role; a page whose style lint is `block` waits
 * for the check of its source head and for its error-severity violations to
 * be resolved, or for an admin's override (#74); a spec whose source head
 * breaks its API waits for an admin's acknowledgement under a `block` policy
 * (#78).
 */
@Injectable()
export class MergeRequestsService {
  private readonly logger = new Logger(MergeRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly compare: CompareService,
    private readonly activity: ActivityService,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    // See DocumentThreadsService: NotificationsService cannot publish, so the
    // frames for `assigned` and `review-requested` are announced from here.
    private readonly events: EventsPublisher,
    private readonly permissions: PermissionService,
    private readonly apiDiffs: ApiSpecDiffService,
    private readonly entities: EntitiesService,
    private readonly lint: LintChecksService,
    private readonly audit: AuditService,
    private readonly conflicts: ConflictsService,
    private readonly commits: ProjectCommitsService,
  ) {}

  /**
   * `opts.provenance` says who opened it when that is not a person (issue
   * #73): an agent's finding, or an agent-session capture with its row id. An
   * argument, not a DTO field — no REST caller may claim to be an agent.
   */
  async create(
    documentId: string,
    dto: CreateMergeRequestDto,
    authorId: string = AUTHOR_ID_STUB,
    opts: { provenance?: MergeRequestProvenance; captureId?: string } = {},
  ): Promise<CreateMergeRequestResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    // An archived page is read-only until unarchived (docs/features/39): the
    // same 409 DocumentsService raises for a revision, so a client has one
    // reason to branch on.
    if (document.archivedAt) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.archived', { id: documentId }),
        reason: DOCUMENT_ARCHIVED,
      });
    }

    const targetName = dto.targetBranch ?? document.defaultBranch;
    if (dto.sourceBranch === targetName) {
      throw new BadRequestException(t('error.mergeRequest.sameBranches'));
    }

    const [source, target] = await Promise.all([
      this.getBranchOrThrow(documentId, dto.sourceBranch),
      this.getBranchOrThrow(documentId, targetName),
    ]);
    if (!source.headRevisionId) {
      throw new BadRequestException(t('error.mergeRequest.sourceNotFinalized', { branch: source.name }));
    }

    await this.rejectDuplicateOpen(source, target);
    this.assertTargetsExist(await this.changedPages(source, target.name), target.name);

    const mr = await this.prisma.mergeRequest.create({
      data: {
        documentId,
        sourceBranchId: source.id,
        targetBranchId: target.id,
        title: dto.title,
        description: dto.description ?? null,
        authorId,
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
        ...(opts.captureId ? { captureId: opts.captureId } : {}),
      },
      include: MR_INCLUDE,
    });
    // A merge request is read by everyone who can read the page, so a private
    // branch it names stops being private (#474), on every page it spans
    // (#636). Only someone who may edit that branch got this far (the guard
    // holds `sourceBranch` and `targetBranch`).
    await this.prisma.documentBranch.updateMany({
      where: {
        OR: [{ id: { in: [source.id, target.id] } }, ...(source.projectBranchId ? [{ projectBranchId: source.projectBranchId }] : [])],
        restricted: true,
      },
      data: { restricted: false },
    });
    const page = await this.recordActivity(mr.documentId, 'merge-request.created', mr.id, authorId, {
      title: dto.title,
      sourceBranch: source.name,
      targetBranch: target.name,
    });
    // Opening a merge request is watching it. Recorded as a subscription rather
    // than inferred from `authorId` at fan-out time so that unwatching your own
    // merge request actually works.
    if (page) {
      await this.notifications.ensureSubscription(
        page.workspaceId,
        authorId,
        'merge-request',
        mr.id,
        'author',
      );
    }
    return { mergeRequest: await this.toDetail(mr) };
  }

  async list(documentId: string): Promise<ListMergeRequestsResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));

    const rows = await this.prisma.mergeRequest.findMany({
      where: { documentId },
      include: MR_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    // No merge base on list rows — it costs a graph BFS per MR (contracts doc it as null).
    const stats = await this.statsFor(rows.map((r) => r.id));
    return { documentId, mergeRequests: rows.map((mr) => this.toInfo(mr, null, stats.get(mr.id))) };
  }

  async listWorkspace(
    query: ListWorkspaceMergeRequestsRequest,
    scope: AccessScope,
  ): Promise<ListWorkspaceMergeRequestsResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    // Everything except the status filter — the per-status counts (tab badges)
    // apply the same search/people/branch/document scope.
    //
    // Branches are a relation, not a column: the name lives on DocumentBranch,
    // and it is matched as a case-insensitive substring so "auth" finds
    // "feature/auth" (typing a branch name in full, exactly, is not a filter).
    //
    // A merge request is its page: one on a page the caller may not open is
    // not in the list, nor in the tab counts (#76).
    const baseWhere = {
      document: { workspaceId: query.workspaceId, AND: [visibilityWhere(scope)] },
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
      ...(query.documentId ? { documentId: query.documentId } : {}),
      ...(query.reviewerId ? { reviewers: { some: { userId: query.reviewerId } } } : {}),
      ...(query.sourceBranch
        ? { sourceBranch: { name: { contains: query.sourceBranch, mode: 'insensitive' as const } } }
        : {}),
      ...(query.targetBranch
        ? { targetBranch: { name: { contains: query.targetBranch, mode: 'insensitive' as const } } }
        : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...(query.provenance ? { provenance: query.provenance } : {}),
    };
    const [rows, statusCounts] = await Promise.all([
      this.prisma.mergeRequest.findMany({
        where: { ...baseWhere, ...(query.status ? { status: query.status } : {}) },
        include: MR_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.prisma.mergeRequest.groupBy({ by: ['status'], where: baseWhere, _count: { _all: true } }),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const stats = await this.statsFor(page.map((r) => r.id));
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const row of statusCounts) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row._count._all;
    }
    return {
      workspaceId: query.workspaceId,
      mergeRequests: page.map((mr) => this.toInfo(mr, null, stats.get(mr.id))),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
      counts,
    };
  }

  async get(mergeRequestId: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    return { mergeRequest: await this.toDetail(mr) };
  }

  /** Title/description/draft-flag edits — open merge requests only. */
  async update(
    mergeRequestId: string,
    dto: UpdateMergeRequestDto,
    actorId?: string,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForEdit', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const changed = (['title', 'description', 'isDraft', 'assigneeId'] as const).filter(
      (k) => dto[k] !== undefined && dto[k] !== mr[k],
    );
    if (changed.length === 0) return { mergeRequest: await this.toDetail(mr) };

    if (dto.assigneeId != null && dto.assigneeId !== mr.assigneeId) {
      await this.assertWorkspaceMembers(mr.documentId, [dto.assigneeId]);
    }
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.isDraft !== undefined ? { isDraft: dto.isDraft } : {}),
        ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
      },
      include: MR_INCLUDE,
    });
    const page = await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: updated.title,
      changed,
      // The activity timeline renders draft and assignee edits as their own
      // system notes ("marked as ready", "assigned to X"), which needs the
      // value that was set and not just the name of the field.
      ...(changed.includes('isDraft') ? { isDraft: updated.isDraft } : {}),
      ...(changed.includes('assigneeId') ? { assigneeId: updated.assigneeId } : {}),
    });
    // Being handed a merge request is addressed to one person, so it is told
    // directly rather than left to the subject's watchers: `merge-request.updated`
    // is not notifiable at all (a title edit is not news), and an assignee who
    // never watched the MR would otherwise hear nothing.
    if (page && updated.assigneeId && changed.includes('assigneeId')) {
      const delivered = await this.notifications.notify({
        workspaceId: page.workspaceId,
        userIds: [updated.assigneeId],
        // The event that actually happened. It is not notifiable on its own —
        // `notificationRowCategory` files this row under `review` from the
        // reason instead.
        type: 'merge-request.updated',
        reason: 'assigned',
        actor: actorId ?? null,
        documentId: mr.documentId,
        subjectType: 'merge-request',
        subjectId: mr.id,
        title: updated.title,
        metadata: { assigned: true },
        subscribe: true,
      });
      await this.events.announce(page.workspaceId, delivered);
    }
    return { mergeRequest: await this.toDetail(updated) };
  }

  /** closed → open. Merged MRs are terminal. */
  async reopen(mergeRequestId: string, actorId?: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'closed') {
      throw new BadRequestException(t('error.mergeRequest.notClosedForReopen', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    await this.rejectDuplicateOpen(mr.sourceBranch, mr.targetBranch);

    // Guarded flip: a concurrent reopen (or delete) makes count 0.
    const flipped = await this.prisma.mergeRequest.updateMany({
      where: { id: mr.id, status: 'closed' },
      data: { status: 'open', closedAt: null },
    });
    if (flipped.count === 0) {
      throw new ConflictException(t('error.mergeRequest.concurrentChange', { id: mr.id }));
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    await this.recordActivity(mr.documentId, 'merge-request.reopened', mr.id, actorId, { title: mr.title });
    return { mergeRequest: await this.toDetail(updated) };
  }

  /** Replace-set reviewer assignment. Reviewers must be members of the document's workspace. */
  async setReviewers(
    mergeRequestId: string,
    reviewerIds: string[],
    actorId?: string,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForReviewers', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const wanted = [...new Set(reviewerIds)];
    await this.assertWorkspaceMembers(mr.documentId, wanted);

    const current = new Set(mr.reviewers.map((r) => r.userId));
    const added = wanted.filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.includes(id));
    if (added.length > 0 || removed.length > 0) {
      await this.prisma.$transaction([
        this.prisma.mergeRequestReviewer.deleteMany({
          where: { mergeRequestId: mr.id, userId: { in: removed } },
        }),
        this.prisma.mergeRequestReviewer.createMany({
          data: added.map((userId) => ({ mergeRequestId: mr.id, userId, addedBy: actorId ?? null })),
        }),
      ]);
    }
    if (added.length > 0) {
      const page = await this.recordActivity(
        mr.documentId,
        'merge-request.review-requested',
        mr.id,
        actorId,
        { title: mr.title, reviewerIds: added },
      );
      // Directed for the same reason as the assignee above: the reviewer ids
      // live in the activity metadata, which never reaches the event bus, so
      // the fan-out could not find these people even in principle.
      if (page) {
        const delivered = await this.notifications.notify({
          workspaceId: page.workspaceId,
          userIds: added,
          type: 'merge-request.review-requested',
          reason: 'review-requested',
          actor: actorId ?? null,
          documentId: mr.documentId,
          subjectType: 'merge-request',
          subjectId: mr.id,
          title: mr.title,
          subscribe: true,
        });
        await this.events.announce(page.workspaceId, delivered);
      }
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    return { mergeRequest: await this.toDetail(updated) };
  }

  /**
   * Merge-base comparison targetHead...sourceHead with structural + (optional)
   * semantic sections, for the page it was opened from and for every changed
   * page `scope` may open (#636).
   */
  async diff(mergeRequestId: string, scope: AccessScope, opts: { semantic?: boolean } = {}): Promise<MergeRequestDiffResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const sourceHead = mr.sourceBranch.headRevisionId;
    if (!sourceHead) throw new BadRequestException(t('error.mergeRequest.branchNoRevisions', { branch: mr.sourceBranch.name }));

    // A page's first merge request (a capture, a chat save) has nothing on the
    // target yet: the whole source is the change (#73).
    const options = { structural: true, semantic: opts.semantic ?? false };
    const compareOf = (documentId: string, target: string | null, source: string) =>
      target
        ? this.compare.compare(documentId, target, source, 'merge-base', options)
        : this.compare.compareWithNothing(documentId, source, options);
    const changed = await this.changedPages(mr.sourceBranch, mr.targetBranch.name);
    const visible = await this.permissions.visibleDocumentIds(scope, changed.map((p) => p.documentId));
    const shown = changed.filter((p) => visible.has(p.documentId));
    const titles = new Map(
      (await this.prisma.document.findMany({ where: { id: { in: shown.map((p) => p.documentId) } }, select: { id: true, title: true } })).map(
        (d) => [d.id, d.title],
      ),
    );
    const pages = await Promise.all(
      shown.map(async (p) => ({
        documentId: p.documentId,
        title: titles.get(p.documentId) ?? '',
        compare: await compareOf(p.documentId, p.target.headRevisionId, p.source.headRevisionId),
      })),
    );
    const compare =
      pages.find((p) => p.documentId === mr.documentId)?.compare ??
      (await compareOf(mr.documentId, mr.targetBranch.headRevisionId, sourceHead));
    return { mergeRequest: await this.toDetail(mr), compare, pages, hiddenPages: changed.length - shown.length };
  }

  /**
   * The pages `source` changes against `targetName`, the page it was opened
   * from first (#636). A page whose source head the target already holds is
   * left out, and so is one with no branch called `targetName` — the caller
   * that lands pages refuses those (`assertTargetsExist`).
   */
  private async changedPages(source: DocumentBranch, targetName: string): Promise<MrPage[] & { missing: string[] }> {
    const branches = (await sourcePages(this.prisma, source)).filter(
      (b): b is MrPage['source'] => b.headRevisionId !== null,
    );
    const targets = await this.prisma.documentBranch.findMany({
      where: { documentId: { in: branches.map((b) => b.documentId) }, name: targetName },
    });
    const byPage = new Map(targets.map((b) => [b.documentId, b]));
    const pages = await Promise.all(
      branches
        .filter((b) => byPage.has(b.documentId))
        .map(async (b): Promise<MrPage> => {
          const target = byPage.get(b.documentId)!;
          const mergeBase = target.headRevisionId
            ? await this.compare.findMergeBase(b.documentId, target.headRevisionId, b.headRevisionId)
            : null;
          return { documentId: b.documentId, source: b, target, mergeBase };
        }),
    );
    return Object.assign(
      pages.filter((p) => p.mergeBase !== p.source.headRevisionId),
      { missing: branches.filter((b) => !byPage.has(b.documentId)).map((b) => b.documentId) },
    );
  }

  /** 400 when a changed page has no branch to land on. Ids, never titles: the caller may not see the page. */
  private assertTargetsExist(pages: { missing: string[] }, targetName: string): void {
    if (pages.missing.length === 0) return;
    throw new BadRequestException(
      t('error.mergeRequest.targetMissing', { branch: targetName, pages: pages.missing.join(', ') }),
    );
  }

  /**
   * What a spec merge request does to its API (#78, phase 6): the classified
   * diff from the merge base to the source head, the pages linking each
   * changed operation as the caller may see them, and whether the gate would
   * refuse a merge now. It describes the first changed spec page the caller
   * may open (#636), while `blocked` answers for every spec page in the merge
   * request, as the gate does. One with no spec page answers
   * `applicable: false`, so the merge-request page can ask without knowing.
   */
  async apiChanges(mergeRequestId: string, scope: AccessScope): Promise<MergeRequestApiChangesResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const state = await this.breakingState(mr, await this.changedPages(mr.sourceBranch, mr.targetBranch.name));
    const visible = await this.permissions.visibleDocumentIds(scope, state.specs.map((s) => s.documentId));
    const shown = state.specs.find((s) => visible.has(s.documentId));
    if (!shown) {
      return {
        mergeRequestId: mr.id,
        documentId: mr.documentId,
        applicable: false,
        policy: DEFAULT_API_BREAKING_CHANGE_POLICY,
        diff: null,
        affectedPages: {},
        ack: null,
        blocked: false,
      };
    }
    const keys = [...new Set((shown.diff?.changes ?? []).map((c) => c.entityKey))].slice(0, 200);
    const pages = await this.entities.inboundPages(scope, keys);
    const affectedPages: MergeRequestApiChangesResponse['affectedPages'] = {};
    for (const key of keys) {
      const list = (pages.get(key) ?? []).filter((p) => p.documentId !== shown.documentId);
      if (list.length) affectedPages[key] = list;
    }
    return {
      mergeRequestId: mr.id,
      documentId: shown.documentId,
      applicable: true,
      policy: state.policy,
      diff: shown.diff,
      affectedPages,
      ack: this.breakingAckOf(mr, state.headCommit),
      blocked: state.blocking !== null,
    };
  }

  /**
   * An admin acknowledges (or withdraws) the breaking changes at the source
   * branch's current head commit (#636). Pinned to it: a later write to any
   * page of the branch is a change nobody has read yet, so the gate closes
   * again until it is acknowledged in turn.
   */
  async setBreakingAck(
    mergeRequestId: string,
    acknowledged: boolean,
    scope: AccessScope,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<MergeRequestApiChangesResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForAck', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const state = await this.breakingState(mr, await this.changedPages(mr.sourceBranch, mr.targetBranch.name));
    const spec = state.specs[0];
    if (!spec) throw new BadRequestException(t('error.mergeRequest.notSpec', { id: mr.id }));

    // `breakingAckRevisionId` is what the previous image reads; this one reads the commit.
    await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: acknowledged
        ? { breakingAckBy: actorId, breakingAckAt: new Date(), breakingAckRevisionId: spec.sourceHeadId, breakingAckCommitId: state.headCommit }
        : { breakingAckBy: null, breakingAckAt: null, breakingAckRevisionId: null, breakingAckCommitId: null },
    });
    await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: mr.title,
      changed: ['breakingAck'],
      breakingAck: acknowledged,
      ...(acknowledged ? { revisionId: spec.sourceHeadId } : {}),
    });
    return this.apiChanges(mr.id, scope);
  }

  /**
   * Each changed spec page's diff from its merge base (or nothing, for a first
   * merge) to its source head, the policy, the source branch's head commit,
   * and the first spec page that would hold a merge — the one predicate the
   * panel and the gate share.
   */
  private async breakingState(
    mr: MrWithBranches,
    pages: MrPage[],
  ): Promise<{
    policy: ApiBreakingChangePolicy;
    headCommit: string | null;
    specs: { documentId: string; sourceHeadId: string; diff: ApiSpecDiff | null }[];
    blocking: { documentId: string; breaking: number } | null;
  }> {
    const docs = await this.prisma.document.findMany({
      where: { id: { in: pages.map((p) => p.documentId) } },
      select: { id: true, kind: true, workspaceId: true, projectId: true },
    });
    const specIds = new Set(docs.filter((d) => isApiSpecKind(d.kind)).map((d) => d.id));
    const specPages = pages.filter((p) => specIds.has(p.documentId));
    if (specPages.length === 0) return { policy: DEFAULT_API_BREAKING_CHANGE_POLICY, headCommit: null, specs: [], blocking: null };
    const [policy, headCommit, specs] = await Promise.all([
      this.apiDiffs.breakingPolicy(docs[0].workspaceId),
      this.commits.headCommit(docs[0].projectId, mr.sourceBranch.name),
      Promise.all(
        specPages.map(async (p) => {
          const base = p.target.headRevisionId ? (p.mergeBase ?? p.target.headRevisionId) : null;
          const diff = await this.apiDiffs.diff(p.documentId, base, p.source.headRevisionId);
          return { documentId: p.documentId, sourceHeadId: p.source.headRevisionId, diff };
        }),
      ),
    ]);
    const acked = this.breakingAckOf(mr, headCommit)?.current ?? false;
    const hit = policy === 'block' && !acked ? specs.find((s) => (s.diff?.summary.breaking ?? 0) > 0) : undefined;
    return { policy, headCommit, specs, blocking: hit ? { documentId: hit.documentId, breaking: hit.diff!.summary.breaking } : null };
  }

  private breakingAckOf(mr: MergeRequest, headCommit: string | null): ApiBreakingAck | null {
    if (!mr.breakingAckBy || !mr.breakingAckRevisionId) return null;
    return {
      by: mr.breakingAckBy,
      at: (mr.breakingAckAt ?? mr.createdAt).toISOString(),
      revisionId: mr.breakingAckRevisionId,
      current: mr.breakingAckCommitId !== null && mr.breakingAckCommitId === headCommit,
    };
  }

  /**
   * An admin lets the current source head merge despite its style check
   * (#74): one still to come, or one with violations left open. Bound to that
   * head — a later push is linted afresh and needs its own pass or override.
   * Audited, and in the activity feed with its reason.
   */
  async overrideLintCheck(
    mergeRequestId: string,
    checkId: string,
    reason: string,
    principal?: Principal,
  ): Promise<{ check: MergeRequestCheckInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') throw new BadRequestException(t('error.lint.notOpen'));
    const check = await this.prisma.mergeRequestCheck.findFirst({ where: { id: checkId, mergeRequestId: mr.id, kind: 'lint' } });
    if (!check) throw new NotFoundException(t('error.lint.checkNotFound', { id: checkId }));
    // Current = still the head of its page's source branch (#636: one check per page).
    const heads = (await sourcePages(this.prisma, mr.sourceBranch)).map((b) => b.headRevisionId);
    if (!heads.includes(check.headRevisionId)) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.overrideNotCurrent'), reason: 'lint.notCurrent' });
    }
    if (!overridable(check.status as MergeRequestCheckInfo['status'])) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.notOverridable'), reason: 'lint.notOverridable' });
    }

    const actorId = principal?.userId ?? AUTHOR_ID_STUB;
    // Guarded: two admins pressing together write one override, and a check
    // that settled to `passed` meanwhile has nothing left to override.
    const claimed = await this.prisma.mergeRequestCheck.updateMany({
      where: { id: check.id, overriddenAt: null, status: { in: ['pending', 'failed'] } },
      data: { overriddenBy: actorId, overriddenAt: new Date(), overrideReason: reason },
    });
    if (claimed.count === 0) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.alreadyOverridden'), reason: 'lint.alreadyOverridden' });
    }

    const params = { mergeRequestId: mr.id, checkId: check.id, headRevisionId: check.headRevisionId, reason };
    await this.audit.record({
      workspaceId: check.workspaceId,
      actor: principal?.userId ?? 'dev',
      action: 'merge-request.lint-override',
      params,
      ok: true,
    });
    await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: mr.title,
      changed: ['lintOverride'],
      lintOverride: { checkId: check.id, reason },
      revisionId: check.headRevisionId,
    });
    const { checks } = await this.lint.list(mr.id, lintGateEnforced(principal));
    return { check: checks.find((c) => c.checkId === check.id)! };
  }

  /** The page a merge request is on — for a caller that needs its workspace first. */
  async documentOf(mergeRequestId: string): Promise<{ documentId: string }> {
    const mr = await this.prisma.mergeRequest.findUnique({ where: { id: mergeRequestId }, select: { documentId: true } });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return mr;
  }

  /** Records approval by the calling principal; merge requires MR_REQUIRED_APPROVALS of these (author's own excluded). */
  async approve(
    mergeRequestId: string,
    approverId: string = AUTHOR_ID_STUB,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForApproval', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const approved = [...new Set([...this.approvers(mr), approverId])];
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { approvedBy: approved },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.approved', mr.id, approverId, { title: mr.title });
    return { mergeRequest: await this.toDetail(updated) };
  }

  async close(mergeRequestId: string, actorId?: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForClose', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { status: 'closed', closedAt: new Date() },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.closed', mr.id, actorId, { title: mr.title });
    return { mergeRequest: await this.toDetail(updated) };
  }

  /**
   * `opts.onTopOf` (#474, `publishBranch` only): the target head the author
   * reviewed after it moved past the source. The merge lands over that head
   * instead of refusing as diverged — the source's content wins, as it does
   * for a shared draft's "Publish on top" — and over no other head.
   */
  async merge(
    mergeRequestId: string,
    strategy: MergeStrategy = 'merge-commit',
    principal?: Principal,
    opts: { onTopOf?: string } = {},
  ): Promise<MergeMergeRequestResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForMerge', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }

    // --- Merge gates (all before any side effect). The extra keys on these
    // ConflictException bodies are hoisted into the ApiErrorPayload `details`
    // by ApiExceptionFilter — see MergeGateConflictDetails in contracts.
    if (mr.isDraft) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.isDraft', { id: mr.id }),
        reason: 'draft',
      });
    }
    // Approval gate — enforced only for real identities: in AUTH_MODE=none the
    // dev principal IS the zeros author stub (self-approval could never pass),
    // and MCP stdio has no principal. Same trust semantics as requireRole.
    const requiredApprovals =
      principal && principal.mode !== 'dev' ? (this.config.get<number>('MR_REQUIRED_APPROVALS') ?? 1) : 0;
    const approvals = this.approvers(mr).filter((id) => id !== mr.authorId).length;
    if (approvals < requiredApprovals) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.needsApprovals', { id: mr.id, approvals, required: requiredApprovals }),
        reason: 'approvals',
        requiredApprovals,
        approvals,
      });
    }
    const pages = await this.changedPages(mr.sourceBranch, mr.targetBranch.name);
    if (pages.length === 0) throw new BadRequestException(t('error.mergeRequest.nothingToMerge'));
    this.assertTargetsExist(pages, mr.targetBranch.name);
    const { projectId, workspaceId } = await this.prisma.document.findUniqueOrThrow({
      where: { id: mr.documentId },
      select: { projectId: true, workspaceId: true },
    });
    // The guard held the caller to edit on the page the merge request was
    // opened from; a merge writes every page it spans (#636), so each must
    // allow it too. The guard's refusal, never a title.
    if (principal && principal.mode !== 'dev') {
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      for (const p of pages) {
        if (p.documentId !== mr.documentId) await this.permissions.requireLevel(scope, { type: 'document', id: p.documentId }, 'edit');
      }
    }
    // A protected target branch on any page requires workspace admin. Skipped
    // when there is no principal (MCP stdio) and short-circuited in
    // AUTH_MODE=none — the same trust semantics as every other ACL in the codebase.
    if (principal && [mr.targetBranch, ...pages.map((p) => p.target)].some((b) => b.protected)) {
      await this.access.requireRole(principal, workspaceId, 'admin');
    }
    // Style lint (#74): after approvals, before divergence — a rebase would
    // only produce a new head to lint. Not enforced where approvals are not.
    if (lintGateEnforced(principal)) {
      const gate = await this.lint.gate(mr.id, true);
      if (gate.blocked) {
        throw new ConflictException({
          statusCode: 409,
          message:
            gate.blockingCount > 0
              ? t('error.mergeRequest.lintBlocking', { id: mr.id, count: gate.blockingCount })
              : t('error.mergeRequest.lintPending', { id: mr.id }),
          reason: 'lint',
          checkStatus: gate.checkStatus,
          blockingCount: gate.blockingCount,
          checkId: gate.checkId,
        });
      }
    }

    for (const p of pages) {
      const targetHeadId = p.target.headRevisionId;
      if (targetHeadId && p.mergeBase !== targetHeadId && opts.onTopOf !== targetHeadId) {
        // Fast-forward precondition (plan.md §7 conflict semantics): the target
        // advanced past the merge base. 3-way content merge is future work —
        // rebase the source branch (new revision on top of target head) instead.
        throw this.diverged(p.documentId, p.target, p.source, targetHeadId, p.source.headRevisionId);
      }
    }
    // Breaking API changes (#78), last because it parses two specs per spec
    // page: each target head is its merge base here, so these are the diffs
    // the panel showed.
    const breaking = (await this.breakingState(mr, pages)).blocking;
    if (breaking) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.breakingApi', { id: mr.id, count: breaking.breaking }),
        reason: 'breaking-api',
        breakingCount: breaking.breaking,
        documentId: breaking.documentId,
      });
    }

    const message =
      strategy === 'squash'
        ? `${mr.title} (squashed from ${mr.sourceBranch.name})`
        : `Merge branch '${mr.sourceBranch.name}' into '${mr.targetBranch.name}'`;

    // Every page's body is staged before the transaction opens (#636): a draft
    // revision on the target, parented on the head the checks above read, with
    // the source head's bytes. The transaction then only locks, re-checks and
    // finalizes, so its length grows with the page count by finalize's own two
    // S3 reads per page, not by the four a merge used to make inside it.
    const staged: { documentId: string; revisionId: string; targetBranchId: string; targetHeadId: string | null }[] = [];
    let finalized: Awaited<ReturnType<DocumentsService['finalizeRevision']>>;
    try {
      for (const p of pages) {
        const sourceHead = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: p.source.headRevisionId } });
        // Draft on the target branch: createRevision parents it on the target head (order 1).
        const draft = await this.documents.createRevision(p.documentId, {
          branch: p.target.name,
          message,
          contentType: sourceHead.contentType,
        });
        staged.push({ documentId: p.documentId, revisionId: draft.revisionId, targetBranchId: p.target.id, targetHeadId: p.target.headRevisionId });
        if (strategy === 'merge-commit') {
          // Second parent = source head → a true merge node in the revision DAG (plan.md §4).
          await this.prisma.revisionParent.create({
            data: { revisionId: draft.revisionId, parentRevisionId: sourceHead.id, parentOrder: p.target.headRevisionId ? 2 : 1 },
          });
        }
        const draftRow = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
        await this.storage.putObjectText(draftRow.s3Key, await this.storage.getObjectText(sourceHead.s3Key), sourceHead.contentType);
      }

      // The merge revisions and the MR's own status commit together. They did
      // not, and the gap left the worst possible pair of facts: the target
      // branch advanced, so the MR was no longer mergeable, while its status
      // was still `open` — permanently, with no route back. Every page lands,
      // or none does.
      finalized = await this.prisma.withTransaction(
        async () => {
          // The project's commit lock (#636) comes before the branch-row locks:
          // finalizeRevision takes it first too, so the order is the same for
          // every writer and a merge never deadlocks against a plain save.
          await this.commits.lock(projectId);
          // The branch-row locks. The fast-forward precondition above is an
          // unlocked read: under READ COMMITTED it sees the last committed head
          // and NOT a concurrent merge's uncommitted advance, so two mergers
          // could both pass it and the second would then commit over the
          // first's head. Taken in id order, so two merges sharing pages
          // serialize rather than deadlock.
          const ids = staged.map((x) => x.targetBranchId);
          const locked = await this.prisma.$queryRaw<{ id: string; head_revision_id: string | null }[]>`
            SELECT id, head_revision_id FROM document_branches WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE
          `;
          const headNow = new Map(locked.map((r) => [r.id, r.head_revision_id]));
          for (const x of staged) {
            const now = headNow.get(x.targetBranchId) ?? null;
            if (now === x.targetHeadId) continue;
            throw new ConflictException({
              statusCode: 409,
              message: t('error.mergeRequest.divergedWhileMerging', { target: mr.targetBranch.name }),
              reason: 'diverged',
              documentId: x.documentId,
              currentHeadRevisionId: now,
              comparisonUrl: `/v1/documents/${x.documentId}/compare?from=${now}&to=${pages.find((p) => p.documentId === x.documentId)!.source.headRevisionId}&mode=merge-base`,
            });
          }

          // Normal pipeline per page: hash → (branch-scoped) dedupe → branch
          // head advance → outbox → reindex. One project commit for them all,
          // the merger's; a merge commit's second parent is the source
          // branch's head commit, and a squash has one parent, as in git.
          const results: (Awaited<ReturnType<DocumentsService['finalizeRevision']>> & { documentId: string })[] = [];
          for (const x of staged) {
            results.push({ documentId: x.documentId, ...(await this.documents.finalizeRevision(x.documentId, x.revisionId, { commit: false })) });
          }
          await this.commits.recordRevisions(
            results.filter((r) => !r.deduplicated).map((r) => r.revisionId),
            { authorId: principal?.userId, mergedFrom: strategy === 'merge-commit' ? mr.sourceBranch.name : undefined },
          );
          const result = results.find((r) => r.documentId === mr.documentId) ?? results[0];

          // Guarded status flip: a concurrent merge/close of THIS MR loses the race and 409s.
          // Now a rollback too, so the merge revisions it would have orphaned go with it.
          const flipped = await this.prisma.mergeRequest.updateMany({
            where: { id: mr.id, status: 'open' },
            data: { status: 'merged', strategy, mergedRevisionId: result.revisionId, mergedAt: new Date() },
          });
          if (flipped.count === 0) {
            throw new ConflictException(t('error.mergeRequest.concurrentChange', { id: mr.id }));
          }
          // A page that existed only as this merge request is a page now (#73):
          // it joins the tree, the lists and search with the merge.
          await this.prisma.document.updateMany({
            where: { id: { in: pages.map((p) => p.documentId) }, pendingMergeRequestId: mr.id },
            data: { pendingMergeRequestId: null },
          });
          return result;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (e) {
      // What the transaction never finalized is a draft nobody will finish.
      const drafts = { id: { in: staged.map((x) => x.revisionId) }, status: 'draft' };
      await this.prisma.revisionParent.deleteMany({ where: { revision: drafts } }).catch(() => undefined);
      await this.prisma.documentRevision.deleteMany({ where: drafts }).catch(() => undefined);
      throw e;
    }

    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    const mergedRevision = await this.prisma.documentRevision.findUnique({ where: { id: finalized.revisionId } });
    await this.recordActivity(mr.documentId, 'merge-request.merged', mr.id, principal?.userId, {
      title: mr.title,
      strategy,
      mergedRevisionId: finalized.revisionId,
      ...(pages.length > 1 ? { pageCount: pages.length } : {}),
    });
    // #81: the conflicts this merge request was proposed to fix are resolved.
    // Post-commit and non-fatal: the merge stands either way.
    await this.conflicts
      .resolveMerged(mr.id, principal?.userId ?? null)
      .catch((e) => this.logger.warn(`Resolving conflicts for merge request ${mr.id} failed: ${(e as Error).message}`));
    return {
      mergeRequest: await this.toDetail(updated),
      mergedRevision: mergedRevision ? toRevisionInfo(mergedRevision) : null,
    };
  }

  /**
   * Publish a working branch onto the page's default branch (#474): open a
   * merge request from it — or reuse the open one — and merge it at once. When
   * a gate refuses (a protected branch for a non-admin, approvals, lint, a
   * breaking API change, a draft MR) the merge request stays open for review
   * and `merged` is false. Nothing to publish and a default head the author has
   * not seen are refused first, so a refused publish never opens anything.
   */
  async publishBranch(
    documentId: string,
    branchId: string,
    dto: PublishBranchDto,
    principal?: Principal,
  ): Promise<PublishBranchResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    const source = await this.prisma.documentBranch.findFirst({ where: { id: branchId, documentId } });
    if (!source) throw new NotFoundException(t('error.branch.hidden'));
    const target = await this.getBranchOrThrow(documentId, document.defaultBranch);
    if (source.id === target.id) throw new BadRequestException(t('error.branch.publishDefault'));
    if (!source.headRevisionId) throw new BadRequestException(t('error.mergeRequest.sourceNotFinalized', { branch: source.name }));
    // Every page the branch changed (#636), checked as merge() will check them.
    const pages = await this.changedPages(source, target.name);
    if (pages.length === 0) throw new BadRequestException(t('error.mergeRequest.nothingToMerge'));
    this.assertTargetsExist(pages, target.name);
    for (const p of pages) {
      const targetHeadId = p.target.headRevisionId;
      if (targetHeadId && p.mergeBase !== targetHeadId && dto.onTopOf !== targetHeadId) {
        throw this.diverged(p.documentId, p.target, p.source, targetHeadId, p.source.headRevisionId);
      }
    }

    const open = await this.openFrom(source, target);
    const mrId =
      open?.id ?? (await this.create(documentId, { sourceBranch: source.name, title: dto.title }, principal?.userId)).mergeRequest.mergeRequestId;
    const held = async (reason: PublishBranchResponse['reason']): Promise<PublishBranchResponse> => ({
      ...(await this.get(mrId)),
      mergedRevision: null,
      merged: false,
      reason,
    });

    // merge() asks for admin on a protected target and throws; here that is a
    // review to wait for, not an error.
    if (principal && [target, ...pages.map((p) => p.target)].some((b) => b.protected)) {
      const admin = await this.access.requireRole(principal, document.workspaceId, 'admin').then(
        () => true,
        (e: unknown) => {
          if (e instanceof ForbiddenException) return false;
          throw e;
        },
      );
      if (!admin) return held('protected');
    }
    try {
      return { ...(await this.merge(mrId, 'merge-commit', principal, { onTopOf: dto.onTopOf })), merged: true, reason: null };
    } catch (e) {
      const reason = e instanceof ConflictException ? (e.getResponse() as { reason?: unknown }).reason : undefined;
      if (reason === 'approvals' || reason === 'lint' || reason === 'breaking-api' || reason === 'draft') return held(reason);
      throw e;
    }
  }

  /** The fast-forward refusal (plan.md §7), with the comparison a client shows before publishing on top. */
  private diverged(
    documentId: string,
    target: DocumentBranch,
    source: DocumentBranch,
    targetHeadId: string,
    sourceHeadId: string,
  ): ConflictException {
    return new ConflictException({
      statusCode: 409,
      message: t('error.mergeRequest.diverged', { target: target.name, source: source.name }),
      reason: 'diverged',
      documentId,
      currentHeadRevisionId: targetHeadId,
      comparisonUrl: `/v1/documents/${documentId}/compare?from=${targetHeadId}&to=${sourceHeadId}&mode=merge-base`,
    });
  }

  /**
   * The open merge request from `source`'s branch into `target`'s, on any page
   * (#636): a project branch has one merge request per target, whichever
   * page opened it.
   */
  private openFrom(source: DocumentBranch, target: DocumentBranch): Promise<{ id: string } | null> {
    return this.prisma.mergeRequest.findFirst({
      where: {
        status: 'open',
        sourceBranch: source.projectBranchId ? { projectBranchId: source.projectBranchId } : { id: source.id },
        targetBranch: source.projectBranchId ? { name: target.name } : { id: target.id },
      },
      select: { id: true },
    });
  }

  /** 409 when an open MR already exists for the same (source, target) pair. */
  private async rejectDuplicateOpen(source: DocumentBranch, target: DocumentBranch): Promise<void> {
    const existing = await this.openFrom(source, target);
    if (existing) {
      throw new ConflictException(
        t('error.mergeRequest.alreadyOpen', { id: existing.id, source: source.name, target: target.name }),
      );
    }
  }

  /**
   * Merge base costs a graph BFS — computed for detail reads and mutation
   * responses only; list endpoints pass null (documented in contracts).
   */
  private async mergeBaseOf(mr: MrWithBranches): Promise<string | null> {
    const src = mr.sourceBranch.headRevisionId;
    const tgt = mr.targetBranch.headRevisionId;
    return src && tgt ? await this.compare.findMergeBase(mr.documentId, tgt, src) : null;
  }

  /** Batched review-thread counts (one groupBy per response, list rows included). */
  private async statsFor(ids: string[]): Promise<Map<string, { total: number; unresolved: number }>> {
    const map = new Map<string, { total: number; unresolved: number }>(
      ids.map((id) => [id, { total: 0, unresolved: 0 }]),
    );
    if (ids.length === 0) return map;
    const rows = await this.prisma.mergeRequestThread.groupBy({
      by: ['mergeRequestId', 'resolved', 'resolvable'],
      where: { mergeRequestId: { in: ids } },
      _count: { _all: true },
    });
    for (const row of rows) {
      const entry = map.get(row.mergeRequestId)!;
      entry.total += row._count._all;
      // A plain comment is a remark, not an open request — it can never be
      // resolved, so counting it as unresolved would block a merge forever.
      if (!row.resolved && row.resolvable) entry.unresolved += row._count._all;
    }
    return map;
  }

  /** Detail/mutation response body: info with merge base + thread stats. */
  private async toDetail(mr: MrWithBranches): Promise<MergeRequestInfo> {
    const [mergeBase, stats] = await Promise.all([this.mergeBaseOf(mr), this.statsFor([mr.id])]);
    return this.toInfo(mr, mergeBase, stats.get(mr.id));
  }

  /** 400 unless every id reads the document's workspace — a member, and not a guest (#76). */
  private async assertWorkspaceMembers(documentId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const doc = await this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: doc.workspaceId, userId: { in: userIds }, ...WORKSPACE_READER },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    const unknown = userIds.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(t('error.mergeRequest.notMembers', { users: unknown.join(', ') }));
    }
    // Reviewing a page is reading it: someone the page's restrictions keep out
    // cannot be handed it (#76). A 409, because a grant on the page fixes it.
    const admitted = await this.permissions.whoCanOpen({ type: 'document', id: documentId }, userIds);
    const shut = userIds.filter((id) => !admitted.has(id));
    if (shut.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.access.usersWithoutView', { users: shut.join(', ') }),
        reason: 'access.usersWithoutView',
        users: shut,
      });
    }
  }

  private toInfo(
    mr: MrWithBranches,
    mergeBase: string | null,
    threadStats: { total: number; unresolved: number } = { total: 0, unresolved: 0 },
  ): MergeRequestInfo {
    return {
      mergeRequestId: mr.id,
      documentId: mr.documentId,
      title: mr.title,
      description: mr.description,
      sourceBranch: mr.sourceBranch.name,
      targetBranch: mr.targetBranch.name,
      sourceHeadRevisionId: mr.sourceBranch.headRevisionId,
      targetHeadRevisionId: mr.targetBranch.headRevisionId,
      mergeBaseRevisionId: mergeBase,
      status: mr.status as MergeRequestStatus,
      isDraft: mr.isDraft,
      authorId: mr.authorId,
      assigneeId: mr.assigneeId,
      approvedBy: this.approvers(mr),
      reviewers: mr.reviewers.map((r) => r.userId),
      threadStats,
      strategy: (mr.strategy as MergeStrategy | null) ?? null,
      mergedRevisionId: mr.mergedRevisionId,
      createdAt: mr.createdAt.toISOString(),
      mergedAt: mr.mergedAt?.toISOString() ?? null,
      closedAt: mr.closedAt?.toISOString() ?? null,
      provenance: mr.provenance as MergeRequestProvenance,
      captureId: mr.captureId,
    };
  }

  private approvers(mr: MergeRequest): string[] {
    return Array.isArray(mr.approvedBy) ? (mr.approvedBy as string[]) : [];
  }


  /**
   * Public so MergeRequestThreadsService can record against the same funnel.
   *
   * Returns the page it resolved (or null when the page is gone) because the
   * workspace lives on the document, not on the merge request — callers that
   * need it for a notification would otherwise repeat this exact lookup.
   */
  async recordActivity(
    documentId: string,
    action: string,
    subjectId: string,
    actor?: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ workspaceId: string; title: string } | null> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true, title: true },
    });
    if (!doc) return null;
    // The lookup stays inline — callers use the returned page synchronously —
    // but the record itself is post-commit: it publishes onto the Redis bus and
    // fans out notifications, neither of which can be taken back. Callers that
    // run inside a transaction (merge, agent-finding proposals) would otherwise
    // announce a merge request that has not committed. Outside a transaction
    // `onCommit` runs it immediately, so every other caller is unchanged.
    this.prisma.onCommit(() =>
      this.activity.record({
        workspaceId: doc.workspaceId,
        actor,
        action,
        documentId,
        subjectId,
        metadata: { documentTitle: doc.title, ...metadata },
      }),
    );
    return doc;
  }

  private async getMrOrThrow(mergeRequestId: string): Promise<MrWithBranches> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: MR_INCLUDE,
    });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return mr;
  }

  async getBranchOrThrow(documentId: string, name: string): Promise<DocumentBranch> {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name } },
    });
    if (!branch) throw new NotFoundException(t('error.branch.notFound', { name, documentId }));
    return branch;
  }
}
