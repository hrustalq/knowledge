import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import matter from 'gray-matter';
import type {
  BranchInfo,
  FactExtractor,
  CreateBranchResponse,
  CreateDocumentResponse,
  CreateUploadResponse,
  DocumentCategory,
  DocumentContentResponse,
  DocumentDetailResponse,
  DocumentGraphEdge,
  DocumentGraphNode,
  DocumentGraphResponse,
  DocumentSummary,
  DocumentTreeNode,
  DocumentTreeResponse,
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
import { ActivityService } from '../activity/activity.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { bfs, buildAdjacency, docIdOf, docNode, isDocNode } from '../graph/graph-walk.js';
import type {
  CreateBranchDto,
  CreateDocumentDto,
  CreateRevisionDto,
  CreateUploadDto,
  RelationInputDto,
  UpdateDocumentDto,
} from './dto/documents.dto.js';
import type { Document, DocumentBranch, DocumentRevision } from '@prisma/client';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    private readonly ingestion: IngestionProducer,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
  ) {}

  async createDocument(dto: CreateDocumentDto, authorId: string = AUTHOR_ID_STUB): Promise<CreateDocumentResponse> {
    const contentType = dto.content ? `text/${dto.content.format}` : 'text/markdown';

    // Workspace > Project > Document: a project id from another tenant must
    // never silently re-parent the page.
    await this.projects.requireProjectInWorkspace(dto.projectId, dto.workspaceId);

    // Feature 08: nested creation — the parent must exist in the same project.
    if (dto.parentId) {
      const parent = await this.prisma.document.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.projectId !== dto.projectId) {
        throw new BadRequestException(`Parent document ${dto.parentId} not found in this project`);
      }
    }

    const { document, revision } = await this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          workspaceId: dto.workspaceId,
          projectId: dto.projectId,
          title: dto.title,
          category: dto.category ?? 'other',
          parentId: dto.parentId ?? null,
        },
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
          authorId,
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

    await this.activity.record({
      workspaceId: dto.workspaceId,
      actor: authorId,
      action: 'document.created',
      documentId: document.id,
      metadata: { title: dto.title, category: dto.category ?? 'other', projectId: dto.projectId },
    });

    return { documentId: document.id, revisionId: revision.id, branch: 'main', status };
  }

  async createUpload(
    documentId: string,
    dto: CreateUploadDto,
    authorId: string = AUTHOR_ID_STUB,
  ): Promise<CreateUploadResponse> {
    const document = await this.getDocumentOrThrow(documentId);

    let revision: DocumentRevision;
    if (dto.revisionId) {
      revision = await this.getRevisionOrThrow(documentId, dto.revisionId);
      if (revision.status !== 'draft') {
        throw new BadRequestException(`Revision ${revision.id} is ${revision.status}, expected draft`);
      }
    } else {
      revision = await this.createDraftRevision(documentId, { contentType: dto.contentType, authorId });
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
    authorId: string = AUTHOR_ID_STUB,
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
      authorId,
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

    await this.activity.record({
      workspaceId: document.workspaceId,
      actor: revision.authorId,
      action: 'revision.finalized',
      documentId,
      subjectId: revision.id,
      metadata: { title: document.title, revisionNumber: revision.revisionNumber },
    });

    return { revisionId: revision.id, status: 'finalized', ingestionJobId: job.id, deduplicated: false };
  }

  async listDocuments(
    workspaceId: string,
    limit = 20,
    cursor?: string,
    category?: string,
    projectId?: string,
  ): Promise<ListDocumentsResponse> {
    const docs = await this.prisma.document.findMany({
      where: { workspaceId, ...(category ? { category } : {}), ...(projectId ? { projectId } : {}) },
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
        projectId: d.projectId,
        title: d.title,
        defaultBranch: d.defaultBranch,
        category: d.category as DocumentCategory,
        parentId: d.parentId,
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
        projectId: document.projectId,
        title: document.title,
        defaultBranch: document.defaultBranch,
        category: document.category as DocumentCategory,
        parentId: document.parentId,
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
    await this.activity.record({
      workspaceId: document.workspaceId,
      action: 'branch.created',
      documentId,
      subjectId: branch.id,
      metadata: { title: document.title, branch: dto.name },
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
    await this.activity.record({
      workspaceId: document.workspaceId,
      action: 'relations.curated',
      documentId,
      metadata: { title: document.title, type: fact.type, targetKey: fact.target.key },
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
    await this.activity.record({
      workspaceId: document.workspaceId,
      action: 'relations.deleted',
      documentId,
      metadata: { title: document.title, type, targetKey, ...(extractor ? { extractor } : {}) },
    });
    return this.listRelations(documentId);
  }

  /** Feature 01 (docs/features/01): full raw content of a revision. */
  async getContent(documentId: string, revisionId?: string): Promise<DocumentContentResponse> {
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
      revision = headId ? await this.prisma.documentRevision.findUnique({ where: { id: headId } }) : null;
    }
    if (!revision) throw new NotFoundException(`Document ${documentId} has no readable revision`);
    if (revision.status === 'draft') {
      throw new BadRequestException(`Revision ${revision.id} is a draft — finalize it before reading content`);
    }

    const raw = await this.storage.getObjectText(revision.s3Key);
    const parsed = matter(raw);
    return {
      documentId,
      revisionId: revision.id,
      contentType: revision.contentType,
      frontmatter: Object.keys(parsed.data ?? {}).length > 0 ? (parsed.data as Record<string, unknown>) : null,
      markdown: parsed.content,
    };
  }

  /** Features 07 + 08 (docs/features): rename, recategorize, move in the tree. */
  async updateDocument(documentId: string, dto: UpdateDocumentDto, actorId?: string): Promise<DocumentSummary> {
    const document = await this.getDocumentOrThrow(documentId);

    const data: { title?: string; category?: string; parentId?: string | null; projectId?: string } = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.category !== undefined) data.category = dto.category;

    // Project move (Workspace > Project > Document). Cross-workspace moves are
    // out of scope: the S3 key layout, graph vertices and the fulltext index
    // are all keyed by workspace, so the target must be a sibling project.
    let movedSubtree: string[] = [];
    if (dto.projectId !== undefined && dto.projectId !== document.projectId) {
      await this.projects.requireProjectInWorkspace(dto.projectId, document.workspaceId);
      data.projectId = dto.projectId;
      movedSubtree = await this.descendantIds(documentId, document.workspaceId);
      // The old parent stays behind, so the moved document is re-rooted unless
      // the same call supplies a parent inside the target project.
      if (dto.parentId === undefined) data.parentId = null;
    }

    const targetProject = data.projectId ?? document.projectId;
    if (dto.parentId !== undefined) {
      if (dto.parentId === documentId) throw new BadRequestException('A document cannot be its own parent');
      if (dto.parentId !== null) await this.assertValidParent(documentId, dto.parentId, targetProject);
      data.parentId = dto.parentId;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to update');

    const updated = await this.prisma.document.update({ where: { id: documentId }, data });
    // Children follow their parent, otherwise they would be orphaned into a
    // project their ancestor no longer belongs to.
    if (data.projectId && movedSubtree.length > 0) {
      await this.prisma.document.updateMany({
        where: { id: { in: movedSubtree } },
        data: { projectId: data.projectId },
      });
    }
    if (data.title && data.title !== document.title) {
      // Keep the graph vertex label in sync (PG stays authoritative).
      await this.graph.upsertDocumentVertex(document.workspaceId, documentId, data.title).catch(() => {
        /* vertex may not exist yet — created on first index */
      });
    }
    await this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.updated',
      documentId,
      metadata: { title: updated.title, changes: Object.keys(data) },
      // Live data patching: subscribed clients merge the changed fields into
      // their cached copies without a refetch (docs/features/04 + live WS).
      patch: Object.fromEntries(
        Object.keys(data).map((k) => [k, (updated as unknown as Record<string, unknown>)[k]]),
      ),
    });
    return this.toSummary(updated);
  }

  /**
   * Feature 08 (docs/features/08): the document tree. Scoped to one project
   * when `projectId` is given; without it the tree spans the whole workspace,
   * which is what the web falls back to before its projects store resolves.
   */
  async getTree(workspaceId: string, projectId?: string): Promise<DocumentTreeResponse> {
    const docs = await this.prisma.document.findMany({
      where: { workspaceId, ...(projectId ? { projectId } : {}) },
      include: { branches: true },
      orderBy: { title: 'asc' },
    });
    const headIds = docs
      .map((d) => d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId)
      .filter((id): id is string => !!id);
    const heads = await this.prisma.documentRevision.findMany({ where: { id: { in: headIds } } });
    const headById = new Map(heads.map((r) => [r.id, r]));

    const nodes = new Map<string, DocumentTreeNode>();
    for (const d of docs) {
      const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
      nodes.set(d.id, {
        documentId: d.id,
        workspaceId: d.workspaceId,
        projectId: d.projectId,
        title: d.title,
        defaultBranch: d.defaultBranch,
        category: d.category as DocumentCategory,
        parentId: d.parentId,
        headRevisionId: headId,
        headRevisionStatus: headId ? ((headById.get(headId)?.status as RevisionStatus) ?? null) : null,
        createdAt: d.createdAt.toISOString(),
        children: [],
      });
    }
    const roots: DocumentTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      // Missing/legacy parents surface the child as a root — nothing is hidden.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return { workspaceId, projectId: projectId ?? null, roots };
  }

  /**
   * Feature 06 (docs/features/06): the document neighbourhood in the
   * knowledge graph. depth = entity hops (one entity hop = two BFS hops over
   * the bipartite doc→entity graph, same convention as Phase 4 traversal).
   */
  async getDocumentGraph(documentId: string, depth = 1): Promise<DocumentGraphResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const d = Math.min(Math.max(Math.floor(depth) || 1, 1), 3);

    const g = await this.graph.getWorkspaceRelationGraph(document.workspaceId);
    const adj = buildAdjacency(g.edges);
    const hits = bfs(adj, docNode(documentId), d * 2);

    const docIds = new Set<string>([documentId]);
    const entityKeys = new Set<string>();
    const distance = new Map<string, number>([[documentId, 0]]);
    for (const hit of hits) {
      if (isDocNode(hit.node)) {
        const id = docIdOf(hit.node);
        docIds.add(id);
        distance.set(id, hit.hops / 2);
      } else {
        entityKeys.add(hit.node);
        distance.set(hit.node, Math.ceil(hit.hops / 2));
      }
    }

    const docs = await this.prisma.document.findMany({
      where: { id: { in: [...docIds] } },
      select: { id: true, title: true, category: true },
    });
    const docById = new Map(docs.map((x) => [x.id, x]));

    const nodes: DocumentGraphNode[] = [];
    for (const id of docIds) {
      nodes.push({
        id,
        kind: 'document',
        label: docById.get(id)?.title ?? g.documents[id]?.title ?? id,
        category: docById.get(id)?.category,
        distance: distance.get(id) ?? 0,
      });
    }
    for (const key of entityKeys) {
      nodes.push({
        id: key,
        kind: 'entity',
        label: g.entities[key]?.name ?? key,
        entityType: g.entities[key]?.type ?? 'entity',
        distance: distance.get(key) ?? 0,
      });
    }

    const edges: DocumentGraphEdge[] = g.edges
      .filter((e) => docIds.has(e.documentId) && entityKeys.has(e.targetKey))
      .map((e) => ({ from: e.documentId, to: e.targetKey, type: e.type, extractor: e.extractor, confidence: e.confidence }));

    return { documentId, depth: d, nodes, edges };
  }

  /**
   * Cycle protection for feature 08 moves: walking up from the new parent must
   * not reach the document. The parent must also sit in the same project — the
   * tree is rendered per project, so a cross-project parent would be invisible.
   */
  private async assertValidParent(documentId: string, parentId: string, projectId: string): Promise<void> {
    const parent = await this.prisma.document.findUnique({ where: { id: parentId } });
    if (!parent || parent.projectId !== projectId) {
      throw new BadRequestException(`Parent document ${parentId} not found in this project`);
    }
    let cursor: string | null = parent.id;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === documentId) {
        throw new BadRequestException('Move would create a cycle in the document tree');
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next: { parentId: string | null } | null = await this.prisma.document.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = next?.parentId ?? null;
    }
  }

  /**
   * Every document below `documentId` in the tree. One flat query plus an
   * in-Node walk, matching getTree — workspaces are small enough that this
   * beats a recursive CTE, and it reuses the same "missing parent = root"
   * tolerance the rest of the tree code has.
   */
  private async descendantIds(documentId: string, workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true },
    });
    const childrenByParent = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.parentId) continue;
      const siblings = childrenByParent.get(r.parentId) ?? [];
      siblings.push(r.id);
      childrenByParent.set(r.parentId, siblings);
    }
    const out: string[] = [];
    const queue = [documentId];
    const seen = new Set<string>([documentId]);
    while (queue.length > 0) {
      for (const child of childrenByParent.get(queue.shift()!) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  }

  private async toSummary(d: Document): Promise<DocumentSummary> {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId: d.id, name: d.defaultBranch } },
    });
    const head = branch?.headRevisionId
      ? await this.prisma.documentRevision.findUnique({ where: { id: branch.headRevisionId } })
      : null;
    return {
      documentId: d.id,
      workspaceId: d.workspaceId,
      projectId: d.projectId,
      title: d.title,
      defaultBranch: d.defaultBranch,
      category: d.category as DocumentCategory,
      parentId: d.parentId,
      headRevisionId: branch?.headRevisionId ?? null,
      headRevisionStatus: (head?.status as RevisionStatus) ?? null,
      createdAt: d.createdAt.toISOString(),
    };
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
    opts: { branch?: string; message?: string; contentType?: string; authorId?: string },
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
          authorId: opts.authorId ?? AUTHOR_ID_STUB,
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
