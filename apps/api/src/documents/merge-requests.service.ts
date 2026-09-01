import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateMergeRequestResponse,
  ListMergeRequestsResponse,
  MergeMergeRequestResponse,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestStatus,
  MergeStrategy,
  RevisionInfo,
  RevisionStatus,
} from '@knowledge/contracts';
import type { DocumentBranch, DocumentRevision, MergeRequest } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import type { CreateMergeRequestDto } from './dto/merge-requests.dto.js';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

type MrWithBranches = MergeRequest & { sourceBranch: DocumentBranch; targetBranch: DocumentBranch };

/**
 * GitLab-style merge requests over the revision DAG (plan.md §8).
 *
 * Merging is fast-forward-preconditioned: the target head must equal the
 * merge base (i.e. must not have advanced past where the source branched),
 * otherwise 409 + comparison link — 3-way content merge is future work.
 * Strategies:
 *  - merge-commit → new revision with parents [targetHead, sourceHead]
 *  - squash       → new revision parented only on targetHead
 * Either way the merge revision carries the source head's content and goes
 * through the normal finalize → outbox → reindex pipeline.
 */
@Injectable()
export class MergeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly compare: CompareService,
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

    const existing = await this.prisma.mergeRequest.findFirst({
      where: { documentId, sourceBranchId: source.id, targetBranchId: target.id, status: 'open' },
    });
    if (existing) {
      throw new ConflictException(
        `Open merge request ${existing.id} already exists for ${source.name} → ${target.name}`,
      );
    }

    const mr = await this.prisma.mergeRequest.create({
      data: {
        documentId,
        sourceBranchId: source.id,
        targetBranchId: target.id,
        title: dto.title,
        description: dto.description ?? null,
        authorId,
      },
      include: { sourceBranch: true, targetBranch: true },
    });
    return { mergeRequest: await this.toInfo(mr) };
  }

  async list(documentId: string): Promise<ListMergeRequestsResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);

    const rows = await this.prisma.mergeRequest.findMany({
      where: { documentId },
      include: { sourceBranch: true, targetBranch: true },
      orderBy: { createdAt: 'desc' },
    });
    return { documentId, mergeRequests: await Promise.all(rows.map((mr) => this.toInfo(mr))) };
  }

  async get(mergeRequestId: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    return { mergeRequest: await this.toInfo(mr) };
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
    return { mergeRequest: await this.toInfo(mr), compare };
  }

  /** Records approval by the calling principal; merge does not require it (yet). */
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
      include: { sourceBranch: true, targetBranch: true },
    });
    return { mergeRequest: await this.toInfo(updated) };
  }

  async close(mergeRequestId: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only open merge requests can be closed`);
    }
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { status: 'closed', closedAt: new Date() },
      include: { sourceBranch: true, targetBranch: true },
    });
    return { mergeRequest: await this.toInfo(updated) };
  }

  async merge(mergeRequestId: string, strategy: MergeStrategy = 'merge-commit'): Promise<MergeMergeRequestResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(`Merge request ${mr.id} is ${mr.status} — only open merge requests can be merged`);
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
    // Normal pipeline: hash → (branch-scoped) dedupe → branch head advance → outbox → reindex.
    const finalized = await this.documents.finalizeRevision(mr.documentId, draft.revisionId);

    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { status: 'merged', strategy, mergedRevisionId: finalized.revisionId, mergedAt: new Date() },
      include: { sourceBranch: true, targetBranch: true },
    });
    const mergedRevision = await this.prisma.documentRevision.findUnique({ where: { id: finalized.revisionId } });
    return {
      mergeRequest: await this.toInfo(updated),
      mergedRevision: mergedRevision ? this.toRevisionInfo(mergedRevision) : null,
    };
  }

  private async toInfo(mr: MrWithBranches): Promise<MergeRequestInfo> {
    const src = mr.sourceBranch.headRevisionId;
    const tgt = mr.targetBranch.headRevisionId;
    const mergeBase = src && tgt ? await this.compare.findMergeBase(mr.documentId, tgt, src) : null;
    return {
      mergeRequestId: mr.id,
      documentId: mr.documentId,
      title: mr.title,
      description: mr.description,
      sourceBranch: mr.sourceBranch.name,
      targetBranch: mr.targetBranch.name,
      sourceHeadRevisionId: src,
      targetHeadRevisionId: tgt,
      mergeBaseRevisionId: mergeBase,
      status: mr.status as MergeRequestStatus,
      approvedBy: this.approvers(mr),
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

  private async getMrOrThrow(mergeRequestId: string): Promise<MrWithBranches> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: { sourceBranch: true, targetBranch: true },
    });
    if (!mr) throw new NotFoundException(`Merge request ${mergeRequestId} not found`);
    return mr;
  }

  private async getBranchOrThrow(documentId: string, name: string): Promise<DocumentBranch> {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name } },
    });
    if (!branch) throw new NotFoundException(`Branch ${name} not found on document ${documentId}`);
    return branch;
  }
}
