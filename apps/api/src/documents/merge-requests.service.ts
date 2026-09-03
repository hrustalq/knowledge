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
import type { Principal } from '../auth/principal.js';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import type { CreateMergeRequestDto, UpdateMergeRequestDto } from './dto/merge-requests.dto.js';

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
  ) {}

  async create(
    documentId: string,
    dto: CreateMergeRequestDto,
    authorId: string = AUTHOR_ID_STUB,
  ): Promise<CreateMergeRequestResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);

    const targetName = dto.targetBranch ?? document.defaultBranch;
    if (dto.sourceBranch === targetName) {
      throw new BadRequestException('Source and target branches must differ');
    }

    const [source, target] = await Promise.all([
      this.getBranchOrThrow(documentId, dto.sourceBranch),
      this.getBranchOrThrow(documentId, targetName),
    ]);
    if (!source.headRevisionId) {
      throw new BadRequestException(`Branch ${source.name} has no finalized revisions to merge`);
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
    await this.recordActivity(mr.documentId, 'merge-request.created', mr.id, authorId, {
      title: dto.title,
      sourceBranch: source.name,
      targetBranch: target.name,
    });
    return { mergeRequest: this.toInfo(mr, await this.mergeBaseOf(mr)) };
  }

  async list(documentId: string): Promise<ListMergeRequestsResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);

    const rows = await this.prisma.mergeRequest.findMany({
      where: { documentId },
      include: MR_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    // No merge base on list rows — it costs a graph BFS per MR (contracts doc it as null).
    return { documentId, mergeRequests: rows.map((mr) => this.toInfo(mr, null)) };
  }

  async listWorkspace(query: ListWorkspaceMergeRequestsRequest): Promise<ListWorkspaceMergeRequestsResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const rows = await this.prisma.mergeRequest.findMany({
      where: {
        document: { workspaceId: query.workspaceId },
        ...(query.status ? { status: query.status } : {}),
        ...(query.authorId ? { authorId: query.authorId } : {}),
        ...(query.documentId ? { documentId: query.documentId } : {}),
        ...(query.reviewerId ? { reviewers: { some: { userId: query.reviewerId } } } : {}),
      },
      include: MR_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      workspaceId: query.workspaceId,
      mergeRequests: page.map((mr) => this.toInfo(mr, null)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async get(mergeRequestId: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    return { mergeRequest: this.toInfo(mr, await this.mergeBaseOf(mr)) };
  }

  /** Title/description/draft-flag edits — open merge requests only. */
  async update(
    mergeRequestId: string,
    dto: UpdateMergeRequestDto,
    actorId?: string,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only open merge requests can be edited`);
    }
    const changed = (['title', 'description', 'isDraft'] as const).filter(
      (k) => dto[k] !== undefined && dto[k] !== mr[k],
    );
    if (changed.length === 0) return { mergeRequest: this.toInfo(mr, await this.mergeBaseOf(mr)) };

    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.isDraft !== undefined ? { isDraft: dto.isDraft } : {}),
      },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: updated.title,
      changed,
    });
    return { mergeRequest: this.toInfo(updated, await this.mergeBaseOf(updated)) };
  }

  /** closed → open. Merged MRs are terminal. */
  async reopen(mergeRequestId: string, actorId?: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'closed') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only closed merge requests can be reopened`);
    }
    await this.rejectDuplicateOpen(mr.documentId, mr.sourceBranch, mr.targetBranch);

    // Guarded flip: a concurrent reopen (or delete) makes count 0.
    const flipped = await this.prisma.mergeRequest.updateMany({
      where: { id: mr.id, status: 'closed' },
      data: { status: 'open', closedAt: null },
    });
    if (flipped.count === 0) {
      throw new ConflictException(`Merge request ${mr.id} changed state concurrently — reload and retry`);
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    await this.recordActivity(mr.documentId, 'merge-request.reopened', mr.id, actorId, { title: mr.title });
    return { mergeRequest: this.toInfo(updated, await this.mergeBaseOf(updated)) };
  }

  /** Replace-set reviewer assignment. Reviewers must be members of the document's workspace. */
  async setReviewers(
    mergeRequestId: string,
    reviewerIds: string[],
    actorId?: string,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — reviewers can only be set while open`);
    }
    const wanted = [...new Set(reviewerIds)];

    const doc = await this.prisma.document.findUniqueOrThrow({
      where: { id: mr.documentId },
      select: { workspaceId: true },
    });
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: doc.workspaceId, userId: { in: wanted } },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    const unknown = wanted.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(`Not members of this workspace: ${unknown.join(', ')}`);
    }

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
      await this.recordActivity(mr.documentId, 'merge-request.review-requested', mr.id, actorId, {
        title: mr.title,
        reviewerIds: added,
      });
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    return { mergeRequest: this.toInfo(updated, await this.mergeBaseOf(updated)) };
  }

  /** Merge-base comparison targetHead...sourceHead with structural + (optional) semantic sections. */
  async diff(mergeRequestId: string, opts: { semantic?: boolean } = {}): Promise<MergeRequestDiffResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const sourceHead = mr.sourceBranch.headRevisionId;
    const targetHead = mr.targetBranch.headRevisionId;
    if (!sourceHead) throw new BadRequestException(`Branch ${mr.sourceBranch.name} has no revisions`);
    if (!targetHead) throw new BadRequestException(`Branch ${mr.targetBranch.name} has no revisions to diff against`);

    const compare = await this.compare.compare(mr.documentId, targetHead, sourceHead, 'merge-base', {
      structural: true,
      semantic: opts.semantic ?? false,
    });
    return { mergeRequest: this.toInfo(mr, await this.mergeBaseOf(mr)), compare };
  }

  /** Records approval by the calling principal; merge requires MR_REQUIRED_APPROVALS of these (author's own excluded). */
  async approve(
    mergeRequestId: string,
    approverId: string = AUTHOR_ID_STUB,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only open merge requests can be approved`);
    }
    const approved = [...new Set([...this.approvers(mr), approverId])];
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { approvedBy: approved },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.approved', mr.id, approverId, { title: mr.title });
    return { mergeRequest: this.toInfo(updated, await this.mergeBaseOf(updated)) };
  }

  async close(mergeRequestId: string, actorId?: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only open merge requests can be closed`);
    }
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { status: 'closed', closedAt: new Date() },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.closed', mr.id, actorId, { title: mr.title });
    return { mergeRequest: this.toInfo(updated, await this.mergeBaseOf(updated)) };
  }

  async merge(
    mergeRequestId: string,
    strategy: MergeStrategy = 'merge-commit',
    principal?: Principal,
  ): Promise<MergeMergeRequestResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only open merge requests can be merged`);
    }

    // --- Merge gates (all before any side effect). The extra keys on these
    // ConflictException bodies are hoisted into the ApiErrorPayload `details`
    // by ApiExceptionFilter — see MergeGateConflictDetails in contracts.
    if (mr.isDraft) {
      throw new ConflictException({
        statusCode: 409,
        message: `Merge request ${mr.id} is a draft — mark it ready before merging`,
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
        message:
          `Merge request ${mr.id} has ${approvals} of ${requiredApprovals} required approvals ` +
          `(the author's own approval does not count)`,
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
    if (!sourceHeadId) throw new BadRequestException(`Branch ${mr.sourceBranch.name} has no revisions`);
    const targetHeadId = mr.targetBranch.headRevisionId;

    const mergeBase = targetHeadId
      ? await this.compare.findMergeBase(mr.documentId, targetHeadId, sourceHeadId)
      : null;
    if (mergeBase === sourceHeadId) {
      throw new BadRequestException('Nothing to merge — the source head is already an ancestor of the target head');
    }
    if (targetHeadId && mergeBase !== targetHeadId) {
      // Fast-forward precondition (plan.md §7 conflict semantics): the target
      // advanced past the merge base. 3-way content merge is future work —
      // rebase the source branch (new revision on top of target head) instead.
      throw new ConflictException({
        statusCode: 409,
        message:
          `Target branch ${mr.targetBranch.name} has advanced past the merge base — ` +
          `rebase ${mr.sourceBranch.name} onto it and retry`,
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

    // Concurrency check: a merge of ANOTHER MR into the same branch may have
    // advanced the head between our fast-forward check and here. Abort before
    // finalize (the orphaned draft revision is harmless — it never finalizes).
    // NOTE: the full fix is a branch-row lock (SELECT … FOR UPDATE) spanning
    // check + finalize, which would require restructuring
    // DocumentsService.finalizeRevision — deliberately deferred.
    const headNow = await this.prisma.documentBranch.findUnique({
      where: { id: mr.targetBranchId },
      select: { headRevisionId: true },
    });
    if ((headNow?.headRevisionId ?? null) !== targetHeadId) {
      throw new ConflictException({
        statusCode: 409,
        message: `Target branch ${mr.targetBranch.name} advanced while merging — retry`,
        reason: 'diverged',
        currentHeadRevisionId: headNow?.headRevisionId ?? null,
        comparisonUrl: `/v1/documents/${mr.documentId}/compare?from=${headNow?.headRevisionId}&to=${sourceHeadId}&mode=merge-base`,
      });
    }

    // Normal pipeline: hash → (branch-scoped) dedupe → branch head advance → outbox → reindex.
    const finalized = await this.documents.finalizeRevision(mr.documentId, draft.revisionId);

    // Guarded status flip: a concurrent merge/close of THIS MR loses the race and 409s.
    const flipped = await this.prisma.mergeRequest.updateMany({
      where: { id: mr.id, status: 'open' },
      data: { status: 'merged', strategy, mergedRevisionId: finalized.revisionId, mergedAt: new Date() },
    });
    if (flipped.count === 0) {
      throw new ConflictException(`Merge request ${mr.id} changed state concurrently — reload and retry`);
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    const mergedRevision = await this.prisma.documentRevision.findUnique({ where: { id: finalized.revisionId } });
    await this.recordActivity(mr.documentId, 'merge-request.merged', mr.id, principal?.userId, {
      title: mr.title,
      strategy,
      mergedRevisionId: finalized.revisionId,
    });
    return {
      mergeRequest: this.toInfo(updated, await this.mergeBaseOf(updated)),
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
        `Open merge request ${existing.id} already exists for ${source.name} → ${target.name}`,
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

  private toInfo(mr: MrWithBranches, mergeBase: string | null): MergeRequestInfo {
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
      approvedBy: this.approvers(mr),
      reviewers: mr.reviewers.map((r) => r.userId),
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

  async recordActivity(
    documentId: string,
    action: string,
    subjectId: string,
    actor?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true, title: true },
    });
    if (!doc) return;
    await this.activity.record({
      workspaceId: doc.workspaceId,
      actor,
      action,
      documentId,
      subjectId,
      metadata: { documentTitle: doc.title, ...metadata },
    });
  }

  private async getMrOrThrow(mergeRequestId: string): Promise<MrWithBranches> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: MR_INCLUDE,
    });
    if (!mr) throw new NotFoundException(`Merge request ${mergeRequestId} not found`);
    return mr;
  }

  async getBranchOrThrow(documentId: string, name: string): Promise<DocumentBranch> {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name } },
    });
    if (!branch) throw new NotFoundException(`Branch ${name} not found on document ${documentId}`);
    return branch;
  }
}
