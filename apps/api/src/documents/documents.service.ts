import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BranchInfo,
  FactExtractor,
  CreateBranchResponse,
  CreateDocumentResponse,
  CreateUploadResponse,
  DocumentDetailResponse,
  DocumentSummary,
  FinalizeRevisionResponse,
  ListBranchesResponse,
  ListDocumentRelationsResponse,
  ListDocumentsResponse,
  ListRevisionsResponse,
  RevisionInfo,
  RevisionStatus,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { IngestionProducer } from '../ingestion/ingestion.producer.js';
import type {
  CreateBranchDto,
  CreateDocumentDto,
  CreateRevisionDto,
  CreateUploadDto,
  RelationInputDto,
} from './dto/documents.dto.js';
import type { DocumentBranch, DocumentRevision } from '@prisma/client';

/** Phase 1 auth stub — replaced by real auth in Phase 5 (plan.md §11). */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    private readonly ingestion: IngestionProducer,
  ) {}

  async createDocument(dto: CreateDocumentDto): Promise<CreateDocumentResponse> {
    const contentType = dto.content ? `text/${dto.content.format}` : 'text/markdown';

    const { document, revision } = await this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: { workspaceId: dto.workspaceId, title: dto.title },
      });
      const branch = await tx.documentBranch.create({
        data: { documentId: document.id, name: 'main', headRevisionId: null },
      });
      const revision = await tx.documentRevision.create({
        data: {
          documentId: document.id,
          branchId: branch.id,
          revisionNumber: 1,
          contentType,
          s3Key: '',
          authorId: AUTHOR_ID_STUB,
          status: 'draft',
        },
      });
      const s3Key = this.storage.revisionObjectKey(dto.workspaceId, document.id, revision.id, 'source.md');
      await tx.documentRevision.update({ where: { id: revision.id }, data: { s3Key } });
      return { document, revision: { ...revision, s3Key } };
    });

    // Explicit relations (plan.md §5 "explicit" fact class) go straight to the graph.
    if (dto.relations?.length) {
      await this.graph.addExplicitRelations({
        workspaceId: document.workspaceId,
        documentId: document.id,
        revisionId: null,
        title: document.title,
        facts: this.toFacts(dto.relations),
      });
    }

    let status: RevisionStatus = 'draft';
    if (dto.content) {
      await this.storage.putObjectText(revision.s3Key, dto.content.text, contentType);
      const finalized = await this.finalizeRevision(document.id, revision.id);
      status = finalized.status;
    }

    return { documentId: document.id, revisionId: revision.id, branch: 'main', status };
  }

  async createUpload(documentId: string, dto: CreateUploadDto): Promise<CreateUploadResponse> {
    const document = await this.getDocumentOrThrow(documentId);

    let revision: DocumentRevision;
    if (dto.revisionId) {
      revision = await this.getRevisionOrThrow(documentId, dto.revisionId);
      if (revision.status !== 'draft') {
        throw new BadRequestException(`Revision ${revision.id} is ${revision.status}, expected draft`);
      }
    } else {
      revision = await this.createDraftRevision(documentId, { contentType: dto.contentType });
    }

    const objectKey = revision.s3Key;
    const url = await this.storage.presignPut(objectKey, dto.contentType);
    return {
      documentId: document.id,
      revisionId: revision.id,
      upload: { method: 'PUT', url, objectKey },
    };
  }

  /**
   * Create a draft revision on a branch head. `expectedHeadRevisionId`
   * (REST `If-Match`, plan.md §7) enables optimistic concurrency: when the
   * branch head has advanced past it, respond 409 with a comparison link
   * instead of silently parenting on someone else's work.
   */
  async createRevision(
    documentId: string,
    dto: CreateRevisionDto,
    expectedHeadRevisionId?: string,
  ): Promise<RevisionInfo> {
    const document = await this.getDocumentOrThrow(documentId);

    if (expectedHeadRevisionId) {
      const branchName = dto.branch ?? document.defaultBranch;
      const branch = await this.prisma.documentBranch.findUnique({
        where: { documentId_name: { documentId, name: branchName } },
      });
      if (!branch) throw new NotFoundException(`Branch ${branchName} not found on document ${documentId}`);
      if (branch.headRevisionId !== expectedHeadRevisionId) {
        throw new ConflictException({
          statusCode: 409,
          message:
            `Branch ${branchName} head is ${branch.headRevisionId ?? 'unset'}, not ${expectedHeadRevisionId} — ` +
            'compare before retrying',
          currentHeadRevisionId: branch.headRevisionId,
          comparisonUrl: branch.headRevisionId
            ? `/v1/documents/${documentId}/compare?from=${expectedHeadRevisionId}&to=${branch.headRevisionId}&mode=merge-base`
            : null,
        });
      }
    }

    const revision = await this.createDraftRevision(documentId, {
      branch: dto.branch,
      message: dto.message,
      contentType: dto.contentType ?? 'text/markdown',
    });
    return this.toRevisionInfo(revision);
  }

  async finalizeRevision(documentId: string, revisionId: string): Promise<FinalizeRevisionResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const revision = await this.getRevisionOrThrow(documentId, revisionId);

    if (revision.status !== 'draft') {
      // Idempotent re-finalize: report current state.
      return { revisionId: revision.id, status: revision.status as RevisionStatus, ingestionJobId: null, deduplicated: false };
    }

    const head = await this.storage.headObject(revision.s3Key);
    if (!head) {
      throw new BadRequestException(`No object uploaded at ${revision.s3Key} — upload before finalizing`);
    }

    const text = await this.storage.getObjectText(revision.s3Key);
    const contentHash = createHash('sha256').update(text, 'utf-8').digest('hex');

    // Content-hash idempotency (plan.md §4), scoped per branch: a merge
    // revision legitimately repeats the source head's content on the target
    // branch (plan.md §8), so dedupe only within this revision's branch.
    const existing = await this.prisma.documentRevision.findFirst({
      where: { documentId, branchId: revision.branchId, contentHash },
    });
    if (existing && existing.id !== revision.id) {
      await this.prisma.$transaction(async (tx) => {
        await tx.revisionParent.deleteMany({ where: { revisionId: revision.id } });
        await tx.documentRevision.delete({ where: { id: revision.id } });
      });
      return { revisionId: existing.id, status: existing.status as RevisionStatus, ingestionJobId: null, deduplicated: true };
    }

    const { job } = await this.prisma.$transaction(async (tx) => {
      await tx.documentRevision.update({
        where: { id: revision.id },
        data: {
          status: 'finalized',
          contentHash,
          s3VersionId: head.versionId,
          finalizedAt: new Date(),
        },
      });
      // Advance the head of the branch this revision belongs to (branch_id,
      // plan.md §4); legacy rows without branchId fall back to the default branch.
      await tx.documentBranch.update({
        where: revision.branchId
          ? { id: revision.branchId }
          : { documentId_name: { documentId, name: document.defaultBranch } },
        data: { headRevisionId: revision.id },
      });
      // Outbox (plan.md §5): the job row commits atomically with the status change;
      // enqueue happens after commit, the sweeper covers enqueue failures.
      const job = await tx.ingestionJob.create({
        data: {
          workspaceId: document.workspaceId,
          revisionId: revision.id,
          type: 'index',
          status: 'queued',
          payload: { documentId, revisionId: revision.id, s3Key: revision.s3Key, title: document.title },
        },
      });
      return { job };
    });

    await this.ingestion.enqueue(job.id).catch(() => {
      /* swallowed: outbox sweeper re-enqueues */
    });

    return { revisionId: revision.id, status: 'finalized', ingestionJobId: job.id, deduplicated: false };
  }

  async listDocuments(workspaceId: string, limit = 20, cursor?: string): Promise<ListDocumentsResponse> {
    const docs = await this.prisma.document.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { branches: true },
    });

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const headIds = page
      .map((d) => d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId)
      .filter((id): id is string => !!id);
    const heads = await this.prisma.documentRevision.findMany({ where: { id: { in: headIds } } });
    const headById = new Map(heads.map((r) => [r.id, r]));

    const items: DocumentSummary[] = page.map((d) => {
      const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
      const head = headId ? headById.get(headId) : undefined;
      return {
        documentId: d.id,
        workspaceId: d.workspaceId,
        title: d.title,
        defaultBranch: d.defaultBranch,
        headRevisionId: headId,
        headRevisionStatus: (head?.status as RevisionStatus) ?? null,
        createdAt: d.createdAt.toISOString(),
      };
    });

    return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async getDocument(documentId: string, revisionId?: string): Promise<DocumentDetailResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: true },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);

    let revision: DocumentRevision | null = null;
    if (revisionId) {
      revision = await this.getRevisionOrThrow(documentId, revisionId);
    } else {
      const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId;
      revision = headId
        ? await this.prisma.documentRevision.findUnique({ where: { id: headId } })
        : await this.prisma.documentRevision.findFirst({
            where: { documentId },
            orderBy: { revisionNumber: 'desc' },
          });
    }
    if (!revision) throw new NotFoundException(`Document ${documentId} has no revisions`);

    const chunks =
      revision.status === 'indexed'
        ? await this.graph.getRevisionChunks(document.workspaceId, revision.id)
        : [];

    const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
    return {
      document: {
        documentId: document.id,
        workspaceId: document.workspaceId,
        title: document.title,
        defaultBranch: document.defaultBranch,
        headRevisionId: headId,
        headRevisionStatus: (revision.status as RevisionStatus) ?? null,
        createdAt: document.createdAt.toISOString(),
      },
      revision: this.toRevisionInfo(revision),
      chunks,
    };
  }

  async createBranch(documentId: string, dto: CreateBranchDto): Promise<CreateBranchResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const existing = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException(`Branch ${dto.name} already exists on document ${documentId}`);
    }

    let head: string | null = null;
    if (dto.fromRevisionId) {
      const rev = await this.getRevisionOrThrow(documentId, dto.fromRevisionId);
      if (!rev.contentHash) {
        throw new BadRequestException(
          `Revision ${rev.id} is ${rev.status} — branches must start from a finalized revision`,
        );
      }
      head = rev.id;
    } else {
      const def = await this.prisma.documentBranch.findUnique({
        where: { documentId_name: { documentId, name: document.defaultBranch } },
      });
      head = def?.headRevisionId ?? null;
    }

    const branch = await this.prisma.documentBranch.create({
      data: { documentId, name: dto.name, headRevisionId: head },
    });
    return { branch: this.toBranchInfo(branch) };
  }

  async listBranches(documentId: string): Promise<ListBranchesResponse> {
    await this.getDocumentOrThrow(documentId);
    const branches = await this.prisma.documentBranch.findMany({
      where: { documentId },
      orderBy: { createdAt: 'asc' },
    });
    return { branches: branches.map((b) => this.toBranchInfo(b)) };
  }

  async listRevisions(documentId: string, branchName?: string): Promise<ListRevisionsResponse> {
    await this.getDocumentOrThrow(documentId);

    let branchId: string | undefined;
    if (branchName) {
      const branch = await this.prisma.documentBranch.findUnique({
        where: { documentId_name: { documentId, name: branchName } },
      });
      if (!branch) throw new NotFoundException(`Branch ${branchName} not found on document ${documentId}`);
      branchId = branch.id;
    }

    const revisions = await this.prisma.documentRevision.findMany({
      where: { documentId, ...(branchId ? { branchId } : {}) },
      include: { parents: { orderBy: { parentOrder: 'asc' } }, branch: true },
      orderBy: { revisionNumber: 'asc' },
    });

    return {
      documentId,
      revisions: revisions.map((r) => ({
        ...this.toRevisionInfo(r),
        branch: r.branch?.name ?? null,
        parentRevisionIds: r.parents.map((p) => p.parentRevisionId),
      })),
    };
  }

  async addRelations(documentId: string, relations: RelationInputDto[]): Promise<ListDocumentRelationsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: document.defaultBranch } },
    });
    await this.graph.addExplicitRelations({
      workspaceId: document.workspaceId,
      documentId,
      revisionId: branch?.headRevisionId ?? null,
      title: document.title,
      facts: this.toFacts(relations),
    });
    return this.listRelations(documentId);
  }

  async listRelations(documentId: string): Promise<ListDocumentRelationsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const rels = await this.graph.getDocumentRelations(document.workspaceId, documentId);
    return {
      documentId,
      relations: rels.map((r) => ({
        type: r.type,
        from: documentId,
        to: { key: r.targetKey, type: r.entityType, name: r.name },
        provenance: {
          revisionId: r.revisionId ?? '',
          extractor: r.extractor as FactExtractor,
          confidence: r.confidence,
          ...(r.sourceChunkId ? { sourceChunkId: r.sourceChunkId } : {}),
          ...(r.snippet ? { snippet: r.snippet } : {}),
        },
      })),
    };
  }

  /**
   * Curate a relation (plan.md §5 "curated" class): user-confirmed, confidence
   * 1, protected from automatic re-extraction overwrites.
   */
  async curateRelation(documentId: string, relation: RelationInputDto): Promise<ListDocumentRelationsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: document.defaultBranch } },
    });
    const [fact] = this.toFacts([relation]);
    await this.graph.curateRelation({
      workspaceId: document.workspaceId,
      documentId,
      revisionId: branch?.headRevisionId ?? null,
      title: document.title,
      fact: { ...fact, extractor: 'curated', confidence: 1 },
    });
    return this.listRelations(documentId);
  }

  /** Delete relation edges by (type, targetKey), optionally a single fact class. */
  async deleteRelation(
    documentId: string,
    type: string,
    targetKey: string,
    extractor?: string,
  ): Promise<ListDocumentRelationsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    await this.graph.deleteRelations(document.workspaceId, documentId, type, targetKey, extractor);
    return this.listRelations(documentId);
  }

  private toFacts(relations: RelationInputDto[]) {
    return relations.map((r) => ({
      type: r.type,
      target: { key: r.target.key, type: r.target.type, name: r.target.name ?? r.target.key },
      extractor: 'explicit' as const,
      confidence: 1,
    }));
  }

  private toBranchInfo(b: DocumentBranch): BranchInfo {
    return {
      branchId: b.id,
      documentId: b.documentId,
      name: b.name,
      headRevisionId: b.headRevisionId,
      protected: b.protected,
      createdAt: b.createdAt.toISOString(),
    };
  }

  private async createDraftRevision(
    documentId: string,
    opts: { branch?: string; message?: string; contentType?: string },
  ): Promise<DocumentRevision> {
    const document = await this.getDocumentOrThrow(documentId);
    const branchName = opts.branch ?? document.defaultBranch;
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: branchName } },
    });
    if (!branch) throw new NotFoundException(`Branch ${branchName} not found on document ${documentId}`);

    return this.prisma.$transaction(async (tx) => {
      const max = await tx.documentRevision.aggregate({
        where: { documentId },
        _max: { revisionNumber: true },
      });
      const revision = await tx.documentRevision.create({
        data: {
          documentId,
          branchId: branch.id,
          revisionNumber: (max._max.revisionNumber ?? 0) + 1,
          contentType: opts.contentType ?? 'text/markdown',
          s3Key: '',
          authorId: AUTHOR_ID_STUB,
          message: opts.message,
          status: 'draft',
        },
      });
      const s3Key = this.storage.revisionObjectKey(document.workspaceId, documentId, revision.id, 'source.md');
      const updated = await tx.documentRevision.update({ where: { id: revision.id }, data: { s3Key } });
      if (branch.headRevisionId) {
        await tx.revisionParent.create({
          data: { revisionId: revision.id, parentRevisionId: branch.headRevisionId, parentOrder: 1 },
        });
      }
      return updated;
    });
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

  private async getDocumentOrThrow(documentId: string) {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    return doc;
  }

  private async getRevisionOrThrow(documentId: string, revisionId: string) {
    const rev = await this.prisma.documentRevision.findUnique({ where: { id: revisionId } });
    if (!rev || rev.documentId !== documentId) {
      throw new NotFoundException(`Revision ${revisionId} not found on document ${documentId}`);
    }
    return rev;
  }
}
