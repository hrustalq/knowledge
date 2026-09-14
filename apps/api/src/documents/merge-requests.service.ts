import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CreateMergeRequestResponse,
  ListMergeRequestsResponse,
  ListWorkspaceMergeRequestsRequest,
  ListWorkspaceMergeRequestsResponse,
  MergeMergeRequestResponse,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestStatus,
  MergeStrategy,
  RevisionInfo,
  RevisionStatus,
} from '@knowledge/contracts';
import type { DocumentBranch, DocumentRevision, MergeRequest, MergeRequestReviewer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AccessService } from '../auth/access.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import type { Principal } from '../auth/principal.js';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import type { CreateMergeRequestDto, UpdateMergeRequestDto } from './dto/merge-requests.dto.js';
import { t } from '../i18n/t.js';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */
export const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

const MR_INCLUDE = { sourceBranch: true, targetBranch: true, reviewers: true } as const;

type MrWithBranches = MergeRequest & {
  sourceBranch: DocumentBranch;
  targetBranch: DocumentBranch;
  reviewers: MergeRequestReviewer[];
};

/**
 * GitLab-style merge requests over the revision DAG (plan.md §8).
 *
 * Merging is fast-forward-preconditioned: the target head must equal the
 * merge base (i.e. must not have advanced past where we branched),
 * otherwise 409 + comparison link — 3-way content merge is future work.
 * Strategies:
 * - merge-commit → new revision with parents [targetHead, sourceHead]
 * - squash      → new revision parented only on targetHead
 * Either way the merge revision carries the source head's content and goes
 * through the normal finalize → outbox → reindex pipeline.
 *
 * Merge gating: draft MRs never merge; MR_REQUIRED_APPROVALS non-author
 * approvals are required (0 disables); merging into a protected branch
 * requires the workspace admin role.
 */
@Injectable()
export class MergeRequestsService {
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
  ) {}

  async create(
    documentId: string,
    dto: CreateMergeRequestDto,
    authorId: string = AUTHOR_ID_STUB,
  ): Promise<CreateMergeRequestResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));

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

    await this.rejectDuplicateOpen(documentId, source, target);

    const mr = await this.prisma.mergeRequest.create({
      data: {
        documentId,
        sourceBranchId: source.id,
        targetBranchId: target.id,
        title: dto.title,
        description: dto.description ?? null,
        authorId,
      },
      include: MR_INCLUDE,
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

  async listWorkspace(query: ListWorkspaceMergeRequestsRequest): Promise<ListWorkspaceMergeRequestsResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    // Everything except the status filter — the per-status counts (tab badges)
    // apply the same search/people/branch/document scope.
    //
    // Branches are a relation, not a column: the name lives on DocumentBranch,
    // and it is matched as a case-insensitive substring so "auth" finds
    // "feature/auth" (typing a branch name in full, exactly, is not a filter).
    const baseWhere = {
      document: { workspaceId: query.workspaceId },
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
    await this.rejectDuplicateOpen(mr.documentId, mr.sourceBranch, mr.targetBranch);

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

  /** Merge-base comparison targetHead...sourceHead with structural + (optional) semantic sections. */
  async diff(mergeRequestId: string, opts: { semantic?: boolean } = {}): Promise<MergeRequestDiffResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const sourceHead = mr.sourceBranch.headRevisionId;
    const targetHead = mr.targetBranch.headRevisionId;
    if (!sourceHead) throw new BadRequestException(t('error.mergeRequest.branchNoRevisions', { branch: mr.sourceBranch.name }));
    if (!targetHead) throw new BadRequestException(t('error.mergeRequest.targetNoRevisions', { branch: mr.targetBranch.name }));

    const compare = await this.compare.compare(mr.documentId, targetHead, sourceHead, 'merge-base', {
      structural: true,
      semantic: opts.semantic ?? false,
    });
    return { mergeRequest: await this.toDetail(mr), compare };
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

  async merge(
    mergeRequestId: string,
    strategy: MergeStrategy = 'merge-commit',
    principal?: Principal,
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
    // Protected target branch requires workspace admin. Skipped when there is
    // no principal (MCP stdio) and short-circuited in AUTH_MODE=none — the
    // same trust semantics as every other ACL in the codebase.
    if (mr.targetBranch.protected && principal) {
      const doc = await this.prisma.document.findUniqueOrThrow({
        where: { id: mr.documentId },
        select: { workspaceId: true },
      });
      await this.access.requireRole(principal, doc.workspaceId, 'admin');
    }

    const sourceHeadId = mr.sourceBranch.headRevisionId;
    if (!sourceHeadId) throw new BadRequestException(t('error.mergeRequest.branchNoRevisions', { branch: mr.sourceBranch.name }));
    const targetHeadId = mr.targetBranch.headRevisionId;

    const mergeBase = targetHeadId
      ? await this.compare.findMergeBase(mr.documentId, targetHeadId, sourceHeadId)
      : null;
    if (mergeBase === sourceHeadId) {
      throw new BadRequestException(t('error.mergeRequest.nothingToMerge'));
    }
    if (targetHeadId && mergeBase !== targetHeadId) {
      // Fast-forward precondition (plan.md §7 conflict semantics): the target
      // advanced past the merge base. 3-way content merge is future work —
      // rebase the source branch (new revision on top of target head) instead.
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.diverged', { target: mr.targetBranch.name, source: mr.sourceBranch.name }),
        reason: 'diverged',
        currentHeadRevisionId: targetHeadId,
        comparisonUrl: `/v1/documents/${mr.documentId}/compare?from=${targetHeadId}&to=${sourceHeadId}&mode=merge-base`,
      });
    }

    const sourceHead = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: sourceHeadId } });
    const message =
      strategy === 'squash'
        ? `${mr.title} (squashed from ${mr.sourceBranch.name})`
        : `Merge branch '${mr.sourceBranch.name}' into '${mr.targetBranch.name}'`;

    // The merge revision and the MR's own status commit together. They did not,
    // and the gap left the worst possible pair of facts: the target branch
    // advanced, so the MR was no longer mergeable, while its status was still
    // `open` — permanently, with no route back.
    //
    // Four S3 round trips live inside (the source GET, the draft PUT, and
    // finalizeRevision's HEAD + GET), hence the raised timeout — the
    // ConnectorStagingService.createPage precedent, and the same numbers: one
    // document body, not a fan-out.
    const finalized = await this.prisma.withTransaction(
      async () => {
        // The branch-row lock this method has wanted since Phase 3. The
        // fast-forward precondition above is an unlocked read: under READ
        // COMMITTED it sees the last committed head and NOT a concurrent
        // merge's uncommitted advance, so two mergers could both pass it and
        // the second would then commit over the first's head.
        //
        // Taking it here rather than inside finalizeRevision is what made this
        // affordable: the boundary already spans check + finalize, so no
        // restructuring of DocumentsService was needed after all. It is also
        // the first branch-row lock in the transaction and the same first lock
        // for every concurrent merger, so the ordering is consistent and two
        // merges into one branch serialize rather than deadlock.
        const locked = await this.prisma.$queryRaw<{ head_revision_id: string | null }[]>`
          SELECT head_revision_id FROM document_branches WHERE id = ${mr.targetBranchId}::uuid FOR UPDATE
        `;
        const headNow = locked[0]?.head_revision_id ?? null;
        if (headNow !== targetHeadId) {
          throw new ConflictException({
            statusCode: 409,
            message: t('error.mergeRequest.divergedWhileMerging', { target: mr.targetBranch.name }),
            reason: 'diverged',
            currentHeadRevisionId: headNow,
            comparisonUrl: `/v1/documents/${mr.documentId}/compare?from=${headNow}&to=${sourceHeadId}&mode=merge-base`,
          });
        }

        // Draft on the target branch: createRevision parents it on the target head (order 1).
        const draft = await this.documents.createRevision(mr.documentId, {
          branch: mr.targetBranch.name,
          message,
          contentType: sourceHead.contentType,
        });
        if (strategy === 'merge-commit') {
          // Second parent = source head → a true merge node in the revision DAG (plan.md §4).
          await this.prisma.revisionParent.create({
            data: {
              revisionId: draft.revisionId,
              parentRevisionId: sourceHeadId,
              parentOrder: targetHeadId ? 2 : 1,
            },
          });
        }

        const draftRow = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
        const text = await this.storage.getObjectText(sourceHead.s3Key);
        await this.storage.putObjectText(draftRow.s3Key, text, sourceHead.contentType);

        // Normal pipeline: hash → (branch-scoped) dedupe → branch head advance → outbox → reindex.
        const result = await this.documents.finalizeRevision(mr.documentId, draft.revisionId);

        // Guarded status flip: a concurrent merge/close of THIS MR loses the race and 409s.
        // Now a rollback too, so the merge revision it would have orphaned goes with it.
        const flipped = await this.prisma.mergeRequest.updateMany({
          where: { id: mr.id, status: 'open' },
          data: { status: 'merged', strategy, mergedRevisionId: result.revisionId, mergedAt: new Date() },
        });
        if (flipped.count === 0) {
          throw new ConflictException(t('error.mergeRequest.concurrentChange', { id: mr.id }));
        }
        return result;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    const mergedRevision = await this.prisma.documentRevision.findUnique({ where: { id: finalized.revisionId } });
    await this.recordActivity(mr.documentId, 'merge-request.merged', mr.id, principal?.userId, {
      title: mr.title,
      strategy,
      mergedRevisionId: finalized.revisionId,
    });
    return {
      mergeRequest: await this.toDetail(updated),
      mergedRevision: mergedRevision ? this.toRevisionInfo(mergedRevision) : null,
    };
  }

  /** 409 when an open MR already exists for the same (source, target) pair. */
  private async rejectDuplicateOpen(
    documentId: string,
    source: DocumentBranch,
    target: DocumentBranch,
  ): Promise<void> {
    const existing = await this.prisma.mergeRequest.findFirst({
      where: { documentId, sourceBranchId: source.id, targetBranchId: target.id, status: 'open' },
    });
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

  /** 400 unless every id is a member of the document's workspace. */
  private async assertWorkspaceMembers(documentId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const doc = await this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: doc.workspaceId, userId: { in: userIds } },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    const unknown = userIds.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(t('error.mergeRequest.notMembers', { users: unknown.join(', ') }));
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
    };
  }

  private approvers(mr: MergeRequest): string[] {
    return Array.isArray(mr.approvedBy) ? (mr.approvedBy as string[]) : [];
  }

  private toRevisionInfo(r: DocumentRevision): RevisionInfo {
    return {
      revisionId: r.id,
      documentId: r.documentId,
      revisionNumber: r.revisionNumber,
      contentHash: r.contentHash,
      contentType: r.contentType,
      status: r.status as RevisionStatus,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
      finalizedAt: r.finalizedAt?.toISOString() ?? null,
    };
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
