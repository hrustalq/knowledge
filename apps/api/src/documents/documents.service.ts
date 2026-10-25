import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import matter from 'gray-matter';
import * as Y from 'yjs';
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
  DocumentAncestorsResponse,
  FinalizeRevisionResponse,
  ListBranchesResponse,
  ListDocumentRelationsResponse,
  ListDocumentsResponse,
  ListRevisionsResponse,
  RevisionInfo,
  RevisionStatus,
  WorkspaceGraphNode,
  WorkspaceGraphResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRevisionInfo } from './revision-info.js';
import { normalizeRelationTarget, tagFilterKey } from '../common/relations.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import type { TemporalPoint } from '../graph/temporal.js';
import { IngestionProducer } from '../ingestion/ingestion.producer.js';
import { ActivityService } from '../activity/activity.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { bfs, buildAdjacency, docIdOf, docNode, isDocNode } from '../graph/graph-walk.js';
import type {
  CreateBranchDto,
  CreateDocumentDto,
  CreateRevisionDto,
  CreateUploadDto,
  MoveDocumentDto,
  RelationInputDto,
  UpdateDocumentDto,
} from './dto/documents.dto.js';
import type { Document, DocumentBranch, DocumentRevision, Prisma } from '@prisma/client';
import {
  entityLayerFor,
  isInactive,
  verificationStateFor,
  type VerificationFlag,
  type VerificationSource,
} from '@knowledge/contracts';
import { ProvenanceService } from '../feedback/provenance.service.js';
import { expiryFor, VerificationPolicyService } from '../verification/verification-policy.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { t } from '../i18n/t.js';
import { ApiSpecsService } from '../api-specs/api-specs.service.js';
import { ApiFixturesService } from '../api-specs/api-fixtures.service.js';
import {
  API_SPEC_SYNTAXES,
  apiSpecSyntaxOf,
  isApiSpecKind,
  isStructuredKind,
  isTestFixtureKind,
  structuredContentType,
  type ApiDocumentKind,
} from '@knowledge/contracts';
import { WORKSPACE_READER } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { AclEventsService } from '../permissions/acl-events.service.js';
import { canSee, visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { LISTED_PAGE } from '../common/listed-page.js';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/**
 * Edge cap for the workspace-wide graph. Chosen for legibility, not for speed:
 * a canvas past a few thousand links is a grey haze whatever the frame rate.
 * The response says when it bit so the UI can tell the reader to narrow scope
 * rather than quietly showing them a partial graph.
 */
const WORKSPACE_GRAPH_MAX_EDGES = 4000;

/**
 * The placeholder `documents.path` carries when an older image wrote the row.
 *
 * It exists so a rollback to a release that predates the column can still
 * insert (docs/versioning.md's expand/contract rule); see
 * `20260918090000_documents_path_rollback_safe`. Deliberately a prefix of no
 * real path, so such a row is inert in subtree queries rather than matching
 * everything the way `''` or `'/'` would.
 */
const PENDING_PATH = '/pending/';

/** A path that actually locates a document, rather than the rollback sentinel. */
export function hasRealPath(path: string): boolean {
  return path !== PENDING_PATH && path.length > 1;
}

/** `details.reason` of the 409 every write to an archived page raises (docs/features/39). */
export const DOCUMENT_ARCHIVED = 'document_archived';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    private readonly ingestion: IngestionProducer,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
    private readonly notifications: NotificationsService,
    private readonly provenance: ProvenanceService,
    private readonly policy: VerificationPolicyService,
    private readonly templates: TemplatesService,
    private readonly permissions: PermissionService,
    private readonly apiSpecs: ApiSpecsService,
    private readonly apiFixtures: ApiFixturesService,
    private readonly aclEvents: AclEventsService,
  ) {}

  async createDocument(input: CreateDocumentDto, authorId: string = AUTHOR_ID_STUB): Promise<CreateDocumentResponse> {
    // Workspace > Project > Document: a project id from another tenant must
    // never silently re-parent the page.
    await this.projects.requireProjectInWorkspace(input.projectId, input.workspaceId);

    // #78: an API spec is parsed by its kind. A template body is markdown, so
    // a spec cannot start from one, and an inline spec is checked before the
    // page exists rather than leaving a page with a refused draft behind. A
    // test fixture (#483) is YAML/JSON too, checked under its author's scope.
    const kind = input.kind ?? 'page';
    if (isStructuredKind(kind)) {
      const errors = isTestFixtureKind(kind) ? 'error.testFixture' : 'error.apiSpec';
      if (input.template) throw new BadRequestException(t(`${errors}.template`));
      if (input.content && !(API_SPEC_SYNTAXES as readonly string[]).includes(input.content.format)) {
        throw new BadRequestException(t(`${errors}.format`, { format: input.content.format }));
      }
      if (input.content && isTestFixtureKind(kind)) {
        await this.apiFixtures.assertValid(input.content.text, await this.permissions.scopeForUser(authorId, input.workspaceId));
      } else if (input.content && isApiSpecKind(kind)) {
        await this.apiSpecs.assertValid(input.content.text, kind);
      }
    }
    const { dto, template } = await this.applyTemplate(input, authorId);
    const contentType = isStructuredKind(kind)
      ? structuredContentType(kind, dto.content?.format === 'json' ? 'json' : 'yaml')
      : dto.content
        ? `text/${dto.content.format}`
        : 'text/markdown';

    // Feature 08: nested creation — the parent must exist in the same project.
    let parent: { path: string; depth: number } | null = null;
    if (dto.parentId) {
      const row = await this.prisma.document.findUnique({ where: { id: dto.parentId } });
      if (!row || row.projectId !== dto.projectId) {
        throw new BadRequestException(t('error.document.parentNotInProject', { id: dto.parentId }));
      }
      parent = { path: row.path, depth: row.depth };
    }

    // `path` contains the row's own id, so the id is minted here rather than by
    // the column default — one insert instead of insert-then-update. The
    // `@default(uuid())` stays for anyone who does not go through this method.
    const id = randomUUID();
    // Unset is `workspace`: only the REST route and the MCP tool, where a
    // person is writing, default to `private` (#474). System writers keep
    // creating pages the workspace sees, without having to say so.
    const isPrivate = dto.visibility === 'private';
    const position = await this.prisma.document.count({
      where: { projectId: dto.projectId, parentId: dto.parentId ?? null },
    });

    // `withTransaction` so an outer boundary absorbs this one — see the note in
    // finalizeRevision. A raw `$transaction` here commits on its own connection
    // regardless of the caller, so an import or connector pull whose outer
    // boundary later rolled back still left the page durably created.
    const { document, revision } = await this.prisma.withTransaction(async () => {
      const document = await this.prisma.document.create({
        data: {
          id,
          workspaceId: dto.workspaceId,
          projectId: dto.projectId,
          title: dto.title,
          category: dto.category ?? (isStructuredKind(kind) ? 'reference' : 'other'),
          kind,
          parentId: dto.parentId ?? null,
          path: `${parent?.path ?? '/'}${id}/`,
          depth: (parent?.depth ?? -1) + 1,
          position,
          templateRef: template?.ref ?? null,
          templateVersion: template?.version ?? null,
          // #474: a private draft is an ordinary restricted page whose author
          // manages it, so every reader that honours restrictions hides it
          // with no code of its own. The marker tells it apart from a page
          // restricted on purpose; `publishDraft` clears all three.
          ...(isPrivate ? { restricted: true, draftOwnerId: authorId } : {}),
        },
      });
      if (isPrivate) {
        await this.prisma.accessGrant.create({
          data: {
            workspaceId: dto.workspaceId,
            resourceType: 'document',
            resourceId: id,
            subjectType: 'user',
            subjectId: authorId,
            level: 'manage',
            createdBy: authorId,
          },
        });
      }
      // A page is born under its parent's and project's restrictions (#76).
      await this.permissions.recomputeRestrictedBy({ documentId: id });
      const branch = await this.prisma.documentBranch.create({
        data: { documentId: document.id, name: 'main', headRevisionId: null },
      });
      const revision = await this.prisma.documentRevision.create({
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
      const s3Key = this.storage.revisionObjectKey(
        dto.workspaceId,
        document.id,
        revision.id,
        this.storage.sourceObjectName(contentType),
      );
      await this.prisma.documentRevision.update({ where: { id: revision.id }, data: { s3Key } });
      return { document, revision: { ...revision, s3Key } };
    });
    // A new restricted node is missing from every cached scope's `denied` set,
    // so live gateways must forget those before this page's first event goes out.
    if (isPrivate) this.prisma.onCommit(() => this.aclEvents.changed(dto.workspaceId, authorId));

    // Explicit relations (plan.md §5 "explicit" fact class) go straight to the graph.
    //
    // Post-commit: this is ArcadeDB over HTTP — one DELETE plus one edge create
    // per fact, each a remote round trip — and it cannot roll back. Running it
    // inline held those round trips inside any caller's transaction boundary
    // (import submit, connector pull, workflow materialise), and wrote graph
    // edges for a page that might still roll back. Outside a transaction
    // `onCommit` runs it immediately, so the un-wrapped callers are unchanged.
    if (dto.relations?.length) {
      const facts = this.toFacts(dto.relations);
      this.prisma.onCommit(() =>
        this.graph.addExplicitRelations({
          workspaceId: document.workspaceId,
          documentId: document.id,
          revisionId: null,
          title: document.title,
          facts,
        }),
      );
    }

    let status: RevisionStatus = 'draft';
    if (dto.content) {
      await this.storage.putObjectText(revision.s3Key, dto.content.text, contentType);
      const finalized = await this.finalizeRevision(document.id, revision.id);
      status = finalized.status;
    }

    // Post-commit for the reason finalizeRevision's record is: `record` publishes
    // onto the Redis bus, which cannot be taken back, and announcing a page that
    // has not committed tells every subscriber about something that may vanish.
    this.prisma.onCommit(() =>
      this.activity.record({
        workspaceId: dto.workspaceId,
        actor: authorId,
        action: 'document.created',
        documentId: document.id,
        metadata: {
          title: dto.title,
          category: dto.category ?? 'other',
          projectId: dto.projectId,
          ...(template ? { templateRef: template.ref, templateVersion: template.version } : {}),
        },
      }),
    );
    // Writing a page is watching it (docs/features/22). A subscription row
    // rather than an implicit rule at fan-out time, so that an author who
    // unwatches their own page stays unwatched.
    await this.notifications.ensureSubscription(
      dto.workspaceId,
      authorId,
      'document',
      document.id,
      'author',
    );

    return { documentId: document.id, revisionId: revision.id, branch: 'main', status };
  }

  /**
   * A page started from a template (issue #69).
   *
   * Without `content` — an MCP agent or an API-first caller — the template is
   * rendered here: its title pattern, body and frontmatter become the page,
   * and the `tags:`/`relations:` in that frontmatter become graph edges at
   * indexing like any hand-written page's. With `content` — the editor, which
   * rendered the skeleton and let the author change it — what the author
   * publishes wins, and the template is recorded as provenance once it is
   * known to resolve. `provenanceOnly` is the editor's case: no `content`,
   * because the body is uploaded afterwards, and rendering here would finalize
   * a skeleton the author never published. Either way the template's category
   * is only a default.
   */
  private async applyTemplate(
    dto: CreateDocumentDto,
    authorId: string,
  ): Promise<{ dto: CreateDocumentDto; template: { ref: string; version: number } | null }> {
    if (!dto.template) return { dto, template: null };
    if (dto.content || dto.template.provenanceOnly) {
      const resolved = await this.templates.resolve(dto.workspaceId, dto.template.ref, dto.template.version);
      return {
        dto: { ...dto, category: dto.category ?? resolved.parsed.meta.category },
        template: { ref: resolved.ref, version: resolved.version },
      };
    }
    const rendered = await this.templates.render(
      {
        workspaceId: dto.workspaceId,
        ref: dto.template.ref,
        version: dto.template.version,
        title: dto.title,
        values: dto.template.values,
        projectId: dto.projectId,
        parentId: dto.parentId,
      },
      { id: authorId },
    );
    return {
      dto: {
        ...dto,
        title: rendered.title,
        category: dto.category ?? rendered.category,
        content: { mode: 'inline', format: 'markdown', text: rendered.markdown },
      },
      template: { ref: rendered.templateRef, version: rendered.templateVersion },
    };
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
        throw new BadRequestException(
        t('error.document.revisionNotDraft', {
          id: revision.id,
          status: t(`status.revision.${revision.status}`),
        }),
      );
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
    this.assertNotArchived(document);

    if (expectedHeadRevisionId) {
      const branchName = dto.branch ?? document.defaultBranch;
      const branch = await this.prisma.documentBranch.findUnique({
        where: { documentId_name: { documentId, name: branchName } },
      });
      if (!branch) throw new NotFoundException(t('error.branch.notFound', { name: branchName, documentId }));
      if (branch.headRevisionId !== expectedHeadRevisionId) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.branch.headMoved', {
            name: branchName,
            actual: branch.headRevisionId ?? 'unset',
            expected: expectedHeadRevisionId,
          }),
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
      // No default here: createDraftRevision picks one from the document's kind.
      contentType: dto.contentType,
      authorId,
      collab: dto.collabDraftId ? await this.draftOf(documentId, dto.branch ?? document.defaultBranch, dto) : undefined,
    });
    return toRevisionInfo(revision);
  }

  /**
   * A revision published from a shared draft (#80) names the draft and the Y
   * snapshot its content was serialized at. The draft must be this branch's:
   * finalize rebases it, and rebasing another page's draft would mark edits
   * published that never were.
   */
  private async draftOf(
    documentId: string,
    branch: string,
    dto: CreateRevisionDto,
  ): Promise<{ draftId: string; snapshot: Uint8Array<ArrayBuffer> }> {
    const draft = await this.prisma.collabDraft.findFirst({
      where: { id: dto.collabDraftId, documentId, branch: { name: branch } },
      select: { id: true },
    });
    if (!draft) {
      throw new BadRequestException(t('error.collab.draftMismatch', { draftId: dto.collabDraftId, branch, documentId }));
    }
    const snapshot = new Uint8Array(Buffer.from(dto.draftSnapshot ?? '', 'base64'));
    try {
      Y.decodeSnapshot(snapshot);
    } catch {
      throw new BadRequestException(t('error.collab.snapshotInvalid'));
    }
    return { draftId: draft.id, snapshot };
  }

  /**
   * Rebase a shared draft onto the revision just published from it, inside
   * the caller's transaction: its base becomes `revisionId`, what it held at
   * the snapshot reads as published, and whoever wrote in it since the last
   * publish is credited on the revision (`credit`) and cleared. Edits a peer
   * made after the snapshot stay unpublished.
   */
  private async markPublished(draftId: string, revisionId: string, snapshot: Uint8Array<ArrayBuffer> | null, credit: boolean): Promise<void> {
    if (credit) {
      await this.prisma.$executeRaw`
        UPDATE document_revisions r SET co_author_ids = d.contributors
        FROM collab_drafts d WHERE r.id = ${revisionId}::uuid AND d.id = ${draftId}::uuid`;
    }
    await this.prisma.collabDraft.updateMany({
      where: { id: draftId },
      data: { baseRevisionId: revisionId, publishedSnapshot: snapshot, contributors: [] },
    });
  }

  async finalizeRevision(documentId: string, revisionId: string): Promise<FinalizeRevisionResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    this.assertNotArchived(document);
    const revision = await this.getRevisionOrThrow(documentId, revisionId);

    if (revision.status !== 'draft') {
      // Idempotent re-finalize: report current state.
      return { revisionId: revision.id, status: revision.status as RevisionStatus, ingestionJobId: null, deduplicated: false };
    }

    const head = await this.storage.headObject(revision.s3Key);
    if (!head) {
      throw new BadRequestException(t('error.document.uploadMissing', { key: revision.s3Key }));
    }

    const text = await this.storage.getObjectText(revision.s3Key);
    // #78: a spec that will not parse is refused here, with the validator's
    // messages, rather than queued to fail in the worker. The draft stays, so
    // the caller can upload a corrected body to the same revision.
    if (isApiSpecKind(document.kind)) await this.apiSpecs.assertValid(text, document.kind);
    // #483: every call must name an operation at a spec head the revision's
    // author can open, checked as that author — not as whoever finalizes.
    if (isTestFixtureKind(document.kind)) {
      await this.apiFixtures.assertValid(text, await this.permissions.scopeForUser(revision.authorId, document.workspaceId));
    }
    const contentHash = createHash('sha256').update(text, 'utf-8').digest('hex');

    // Content-hash idempotency (plan.md §4), scoped per branch: a merge
    // revision legitimately repeats the source head's content on the target
    // branch (plan.md §8), so dedupe only within this revision's branch.
    const existing = await this.prisma.documentRevision.findFirst({
      where: { documentId, branchId: revision.branchId, contentHash },
    });
    if (existing && existing.id !== revision.id) {
      await this.prisma.withTransaction(async () => {
        await this.prisma.revisionParent.deleteMany({ where: { revisionId: revision.id } });
        await this.prisma.documentRevision.delete({ where: { id: revision.id } });
        // The draft says what `existing` says: it is published as that, with
        // no credit to write — `existing` keeps its own.
        if (revision.collabDraftId) await this.markPublished(revision.collabDraftId, existing.id, revision.collabSnapshot, false);
      });
      return { revisionId: existing.id, status: existing.status as RevisionStatus, ingestionJobId: null, deduplicated: true };
    }

    // `withTransaction`, NOT `$transaction`: `$transaction` is in
    // NEVER_FROM_TRANSACTION, so under an outer boundary it opens a SECOND
    // transaction on a SECOND pooled connection instead of joining. That is a
    // deadlock, not an inefficiency — `MergeRequestsService.merge` holds
    // `document_branches ... FOR UPDATE` on the outer connection and this block
    // updates that same row, so the inner connection waits for a lock the outer
    // will not release until this call returns. Postgres sees the outer as
    // `idle in transaction` rather than blocked, so its deadlock detector never
    // fires and the request hangs until something kills the connection.
    const { job } = await this.prisma.withTransaction(async () => {
      await this.prisma.documentRevision.update({
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
      await this.prisma.documentBranch.update({
        where: revision.branchId
          ? { id: revision.branchId }
          : { documentId_name: { documentId, name: document.defaultBranch } },
        data: { headRevisionId: revision.id },
      });
      if (revision.collabDraftId) await this.markPublished(revision.collabDraftId, revision.id, revision.collabSnapshot, true);
      // Outbox (plan.md §5): the job row commits atomically with the status change;
      // enqueue happens after commit, the sweeper covers enqueue failures.
      const job = await this.prisma.ingestionJob.create({
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

    // Both of these are post-commit by contract, and `onCommit` is what keeps
    // them so when a caller has wrapped this method in an outer transaction: the
    // inner `withTransaction` above then joins rather than commits, and enqueueing
    // here inline would hand the worker a job for an `ingestion_jobs` row that
    // has not committed — or never will, if the outer boundary rolls back.
    // Outside a transaction `onCommit` runs them immediately, so the un-wrapped
    // path is unchanged. Failures stay swallowed: the outbox sweeper re-enqueues,
    // and the event bus is best-effort.
    this.prisma.onCommit(() => this.ingestion.enqueue(job.id));
    this.prisma.onCommit(() =>
      this.activity.record({
        workspaceId: document.workspaceId,
        actor: revision.authorId,
        action: 'revision.finalized',
        documentId,
        subjectId: revision.id,
        metadata: { title: document.title, revisionNumber: revision.revisionNumber },
      }),
    );

    return { revisionId: revision.id, status: 'finalized', ingestionJobId: job.id, deduplicated: false };
  }

  /**
   * The document list, filtered by the same facets the search sheet offers.
   *
   * Categories and projects are columns, so they filter in PG. Tags are not:
   * frontmatter `tags:` become `tag:<name>` entities in the graph, so they are
   * resolved to a document-id set first — exactly as SearchService does it, via
   * the same GraphService call, so a tag means one thing in both surfaces.
   */
  async listDocuments(
    scope: AccessScope,
    limit = 20,
    cursor?: string,
    filters: { categories?: string[]; projectIds?: string[]; tags?: string[]; includeArchived?: boolean } = {},
  ): Promise<ListDocumentsResponse> {
    const { workspaceId } = scope;
    const categories = filters.categories?.filter(Boolean) ?? [];
    const projectIds = filters.projectIds?.filter(Boolean) ?? [];
    const tags = filters.tags?.filter(Boolean) ?? [];

    let taggedIds: string[] | null = null;
    if (tags.length) {
      // Accept the bare name or the entity key, like the search filters do.
      const keys = [...new Set(tags.map(tagFilterKey))];
      const set = await this.graph.getDocumentIdsByTags(workspaceId, keys, await this.permissions.documentFilterFor(scope));
      taggedIds = [...set];
      // No document carries the tag: answer an empty page rather than dropping
      // the filter and showing everything, which is the wrong kind of helpful.
      if (taggedIds.length === 0) return { items: [], nextCursor: null };
    }

    const docs = await this.prisma.document.findMany({
      where: {
        workspaceId,
        // Archived pages are put away, not deleted: absent unless asked for (docs/features/39).
        ...(filters.includeArchived ? {} : { archivedAt: null }),
        ...(categories.length ? { category: { in: categories } } : {}),
        ...(projectIds.length ? { projectId: { in: projectIds } } : {}),
        ...(taggedIds ? { id: { in: taggedIds } } : {}),
        // Pages the caller may not open are not in the list at all (#76), nor
        // a page that is still only a merge request (#73).
        ...LISTED_PAGE,
        AND: [visibilityWhere(scope)],
      },
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
    const [heads, issues, settings] = await Promise.all([
      this.prisma.documentRevision.findMany({ where: { id: { in: headIds } } }),
      this.provenance.openIssueCounts(page.map((d) => d.id)),
      this.policy.effective(workspaceId),
    ]);
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
        ...this.trustFields(d, headId, issues.get(d.id) ?? 0, settings.inactiveAfterDays),
      };
    });

    return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /**
   * The verification, ownership, freshness and archive fields every summary
   * carries (docs/features/39). The state is derived here, at read time, from
   * the row, the head and the open-report count — never stored.
   */
  private trustFields(
    d: Document,
    headId: string | null,
    openIssues: number,
    inactiveAfterDays: number,
  ): Pick<
    DocumentSummary,
    | 'verifiedAt'
    | 'verifiedBy'
    | 'verifiedRevisionId'
    | 'verification'
    | 'ownerId'
    | 'reviewIntervalDays'
    | 'verificationExpiresAt'
    | 'verificationFlag'
    | 'verificationNote'
    | 'verificationSource'
    | 'lastActivityAt'
    | 'inactive'
    | 'archivedAt'
    | 'archivedBy'
    | 'templateRef'
    | 'templateVersion'
    | 'restricted'
    | 'draftOwnerId'
  > {
    return {
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      verifiedBy: d.verifiedBy,
      verifiedRevisionId: d.verifiedRevisionId,
      verification: verificationStateFor(d, headId, openIssues),
      ownerId: d.ownerId,
      reviewIntervalDays: d.reviewIntervalDays,
      verificationExpiresAt: d.verificationExpiresAt?.toISOString() ?? null,
      verificationFlag: (d.verificationFlag as VerificationFlag | null) ?? null,
      verificationNote: d.verificationNote,
      verificationSource: (d.verificationSource as unknown as VerificationSource | null) ?? null,
      lastActivityAt: d.lastActivityAt.toISOString(),
      inactive: isInactive(d.lastActivityAt, inactiveAfterDays),
      archivedAt: d.archivedAt?.toISOString() ?? null,
      archivedBy: d.archivedBy,
      // Provenance (issue #69) rides along: every caller of this already wants
      // the full page row, and a second spread at each would be a third place to forget.
      templateRef: d.templateRef,
      templateVersion: d.templateVersion,
      restricted: d.restrictedBy.length > 0,
      draftOwnerId: d.draftOwnerId,
    };
  }

  /**
   * Hand the page to a member, or to nobody. One place, so `PATCH :id` and the
   * knowledge-health bulk path validate membership the same way: the owner must
   * hold a `workspace_members` row in the page's workspace — the dev principal
   * is the one exception, and only because `AUTH_MODE=none` has no rows at all.
   * The new owner is told (reason `owner`), the actor never is.
   */
  async setOwner(documentId: string, ownerId: string | null, actorId?: string): Promise<DocumentSummary> {
    const document = await this.getDocumentOrThrow(documentId);
    this.assertNotArchived(document);
    if (ownerId !== null) await this.assertMember(document.workspaceId, ownerId);
    if (ownerId === document.ownerId) return this.toSummary(document);
    const updated = await this.prisma.document.update({ where: { id: documentId }, data: { ownerId } });
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.owner-changed',
      documentId,
      projectId: document.projectId,
      metadata: { title: document.title, from: document.ownerId, to: ownerId },
      patch: { ownerId },
    });
    if (ownerId && ownerId !== actorId) {
      void this.notifications.notify({
        workspaceId: document.workspaceId,
        userIds: [ownerId],
        type: 'document.owner-changed',
        reason: 'owner',
        actor: actorId ?? null,
        documentId,
        subjectType: 'document',
        subjectId: documentId,
        title: document.title,
        subscribe: true,
      });
    }
    return this.toSummary(updated);
  }

  private async assertMember(workspaceId: string, userId: string): Promise<void> {
    if (userId === AUTHOR_ID_STUB) return;
    // A guest cannot own a page: ownership is review duty over something they
    // may not even be able to read (#76).
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId, ...WORKSPACE_READER } });
    if (!member) throw new BadRequestException(t('error.document.ownerNotMember'));
  }

  /** Every write to an archived page is a 409 with `details.reason = document_archived` (docs/features/39). */
  private assertNotArchived(document: { id: string; archivedAt: Date | null }): void {
    if (document.archivedAt) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.archived', { id: document.id }),
        reason: DOCUMENT_ARCHIVED,
      });
    }
  }

  async getDocument(documentId: string, revisionId?: string): Promise<DocumentDetailResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: true },
    });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));

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
    if (!revision) throw new NotFoundException(t('error.document.noRevisions', { id: documentId }));

    const chunks =
      revision.status === 'indexed'
        ? await this.graph.getRevisionChunks(document.workspaceId, revision.id)
        : [];

    const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
    // An open report flags the page (docs/features/38, phase 3) — the same
    // predicate ProvenanceService applies to a cited source.
    const [issues, settings] = await Promise.all([
      this.provenance.openIssueCounts([documentId]),
      this.policy.effective(document.workspaceId),
    ]);
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
        kind: document.kind as ApiDocumentKind,
        // The stamp, the flag and their reading against the head and the
        // clock (docs/features/38 + 39). Writes live in VerificationService.
        ...this.trustFields(document, headId, issues.get(documentId) ?? 0, settings.inactiveAfterDays),
      },
      revision: toRevisionInfo(revision),
      chunks,
    };
  }

  async createBranch(documentId: string, dto: CreateBranchDto): Promise<CreateBranchResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const existing = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException(t('error.branch.exists', { name: dto.name, documentId }));
    }

    let head: string | null = null;
    if (dto.fromRevisionId) {
      const rev = await this.getRevisionOrThrow(documentId, dto.fromRevisionId);
      if (!rev.contentHash) {
        throw new BadRequestException(
          t('error.branch.needsFinalized', { id: rev.id, status: t(`status.revision.${rev.status}`) }),
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
    // Post-commit: publishes onto the bus (see createDocument above).
    this.prisma.onCommit(() =>
      this.activity.record({
        workspaceId: document.workspaceId,
        action: 'branch.created',
        documentId,
        subjectId: branch.id,
        metadata: { title: document.title, branch: dto.name },
      }),
    );
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
      if (!branch) throw new NotFoundException(t('error.branch.notFound', { name: branchName, documentId }));
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
        ...toRevisionInfo(r),
        branch: r.branch?.name ?? null,
        parentRevisionIds: r.parents.map((p) => p.parentRevisionId),
      })),
    };
  }

  async addRelations(documentId: string, relations: RelationInputDto[], actor?: string): Promise<ListDocumentRelationsResponse> {
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
      actor,
    });
    return this.listRelations(documentId);
  }

  async listRelations(documentId: string): Promise<ListDocumentRelationsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    // What the page asserts now (#83): a relation dropped from the frontmatter
    // must leave the relations panel once the new revision is indexed.
    const rels = await this.graph.getDocumentRelations(document.workspaceId, documentId, { liveOnly: true });
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
  async curateRelation(documentId: string, relation: RelationInputDto, actor?: string): Promise<ListDocumentRelationsResponse> {
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
      actor,
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
    actor?: string,
  ): Promise<ListDocumentRelationsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    await this.graph.deleteRelations(document.workspaceId, documentId, type, targetKey, extractor, actor);
    await this.activity.record({
      workspaceId: document.workspaceId,
      action: 'relations.deleted',
      documentId,
      metadata: { title: document.title, type, targetKey, ...(extractor ? { extractor } : {}) },
    });
    return this.listRelations(documentId);
  }

  /** Feature 01 (docs/features/01): full raw content of a revision. */
  /** The page's workspace, for resolving an `asOf` before the read (#81). */
  async workspaceOf(documentId: string): Promise<string> {
    return (await this.getDocumentOrThrow(documentId)).workspaceId;
  }

  /**
   * The default-branch revision that was the page's content at `at` (#81): the
   * newest one finalized by then. A legacy revision with no branch id is on
   * the default branch. 404 when the page had no content yet.
   */
  async revisionAsOf(documentId: string, at: TemporalPoint): Promise<string> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { branches: true } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    const branchId = document.branches.find((b) => b.name === document.defaultBranch)?.id ?? null;
    const revision = await this.prisma.documentRevision.findFirst({
      where: { documentId, finalizedAt: { lte: new Date(at.at) }, OR: [{ branchId }, { branchId: null }] },
      orderBy: { finalizedAt: 'desc' },
      select: { id: true },
    });
    if (!revision) throw new NotFoundException(t('error.document.noReadableRevision', { id: documentId }));
    return revision.id;
  }

  async getContent(documentId: string, revisionId?: string): Promise<DocumentContentResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: true },
    });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));

    let revision: DocumentRevision | null = null;
    if (revisionId) {
      revision = await this.getRevisionOrThrow(documentId, revisionId);
    } else {
      const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId;
      revision = headId ? await this.prisma.documentRevision.findUnique({ where: { id: headId } }) : null;
    }
    if (!revision) throw new NotFoundException(t('error.document.noReadableRevision', { id: documentId }));
    if (revision.status === 'draft') {
      throw new BadRequestException(t('error.document.contentIsDraft', { id: revision.id }));
    }

    const raw = await this.storage.getObjectText(revision.s3Key);
    // A spec (#78) or fixture (#483) is returned verbatim: it has no
    // frontmatter, and YAML may well open with a `---` marker gray-matter would eat.
    const parsed = isStructuredKind(document.kind) ? { data: {}, content: raw } : matter(raw);
    return {
      documentId,
      revisionId: revision.id,
      contentType: revision.contentType,
      frontmatter: Object.keys(parsed.data ?? {}).length > 0 ? (parsed.data as Record<string, unknown>) : null,
      markdown: parsed.content,
    };
  }

  /**
   * Open a private draft to the workspace (#474): clear the marker, lift its
   * own restriction and drop the grants it was shared with, in one
   * transaction, so it ends like any page that was never a draft and keeps
   * only what its parent and project restrict. A child is not published with
   * it, and a draft under a draft stays hidden until the parent is published.
   *
   * Guarded on the marker, so a second publish changes and announces nothing.
   * Watchers hear about the page here, through `document.published`, and not
   * at creation, when nobody but the author could open it.
   */
  async publishDraft(documentId: string, actorId: string): Promise<DocumentDetailResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const published = await this.prisma.withTransaction(async () => {
      const { count } = await this.prisma.document.updateMany({
        where: { id: documentId, draftOwnerId: { not: null } },
        data: { draftOwnerId: null, restricted: false },
      });
      if (count === 0) return false;
      await this.prisma.accessGrant.deleteMany({
        where: { resourceType: 'document', resourceId: documentId, origin: 'manual' },
      });
      await this.permissions.recomputeRestrictedBy({ documentId });
      return true;
    });
    if (published) {
      await this.aclEvents.changed(document.workspaceId, actorId);
      await this.activity.record({
        workspaceId: document.workspaceId,
        actor: actorId,
        action: 'document.published',
        documentId,
        projectId: document.projectId,
        metadata: { title: document.title },
      });
    }
    return this.getDocument(documentId);
  }

  /** Features 07 + 08 (docs/features): rename, recategorize, move in the tree. */
  async updateDocument(documentId: string, dto: UpdateDocumentDto, actorId?: string): Promise<DocumentSummary> {
    const document = await this.getDocumentOrThrow(documentId);
    this.assertNotArchived(document);

    // Ownership is its own act with its own event and notification
    // (docs/features/39); the rest of the patch follows. A call that only
    // changes the owner ends here.
    if (dto.ownerId !== undefined && dto.ownerId !== document.ownerId) {
      await this.setOwner(documentId, dto.ownerId, actorId);
      document.ownerId = dto.ownerId;
    }

    const data: {
      title?: string;
      category?: string;
      parentId?: string | null;
      projectId?: string;
      reviewIntervalDays?: number | null;
      verificationExpiresAt?: Date | null;
    } = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.reviewIntervalDays !== undefined && dto.reviewIntervalDays !== document.reviewIntervalDays) {
      data.reviewIntervalDays = dto.reviewIntervalDays;
      // A stamped page's deadline moves with its interval, from the same
      // arithmetic VerificationService.verify uses.
      if (document.verifiedAt) {
        const settings = await this.policy.effective(document.workspaceId);
        data.verificationExpiresAt = expiryFor(document.verifiedAt, dto.reviewIntervalDays, settings.reviewIntervalDays);
      }
    }
    if (Object.keys(data).length === 0 && dto.ownerId !== undefined) return this.toSummary(await this.getDocumentOrThrow(documentId));

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
    let newParent: { path: string; depth: number } | null = null;
    if (dto.parentId !== undefined) {
      if (dto.parentId === documentId) throw new BadRequestException(t('error.document.selfParent'));
      if (dto.parentId !== null) {
        newParent = await this.assertValidParent(documentId, dto.parentId, targetProject);
      }
      data.parentId = dto.parentId;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException(t('error.document.nothingToUpdate'));

    // A project move with no explicit parent re-roots the page (above), which
    // is a path change too.
    const reparented = data.parentId !== undefined && data.parentId !== document.parentId;
    const oldPath = document.path;
    const newPath = reparented ? `${newParent?.path ?? '/'}${documentId}/` : oldPath;
    const depthDelta = reparented ? (newParent?.depth ?? -1) + 1 - document.depth : 0;

    // One boundary around the row, its subtree's paths and the subtree's
    // project. The subtree re-project used to sit outside any explicit
    // transaction, so a failure between the two left children in a project
    // their parent had already left.
    const updated = await this.prisma.withTransaction(async () => {
      // A reparent lands the page at the end of its new siblings. Without this
      // it kept the index it held under its old parent, which collides with
      // whoever already holds that index there and leaves the tie to be broken
      // by title — so a moved page appeared in an arbitrary slot.
      const position = reparented
        ? await this.prisma.document.count({
            where: { projectId: targetProject, parentId: data.parentId ?? null, id: { not: documentId } },
          })
        : undefined;

      const row = await this.prisma.document.update({
        where: { id: documentId },
        data: reparented ? { ...data, path: newPath, depth: document.depth + depthDelta, position } : data,
      });

      if (reparented) await this.repathSubtree(document.workspaceId, documentId, oldPath, newPath, depthDelta);

      // Children follow their parent, otherwise they would be orphaned into a
      // project their ancestor no longer belongs to.
      if (data.projectId && movedSubtree.length > 0) {
        await this.prisma.document.updateMany({
          where: { id: { in: movedSubtree } },
          data: { projectId: data.projectId },
        });
      }
      // New ancestors or a new project mean a new chain of restrictions for the
      // whole subtree, in this transaction, so nobody reads the page in between
      // with the old ones (#76).
      if (reparented || data.projectId) await this.permissions.recomputeRestrictedBy({ documentId });
      return row;
    });
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
   * Re-point a moved page's descendants at its new path, in one statement for a
   * subtree of any size. Left-anchored LIKE, so the (workspace_id, path) index
   * serves it; the old upward walk could not express this at all.
   *
   * Both movers call this. It is one implementation because the `substring`
   * offset and the depth delta have to agree with the path the row itself was
   * given, and two copies of that arithmetic is how a subtree ends up at a
   * depth its own parent disagrees with.
   */
  private async repathSubtree(
    workspaceId: string,
    documentId: string,
    oldPath: string,
    newPath: string,
    depthDelta: number,
  ): Promise<void> {
    // A rollback sentinel prefixes no real path, so it would match nothing —
    // but it would also silently claim the whole workspace if `oldPath` were
    // ever '/'. Refuse rather than rely on that.
    if (!hasRealPath(oldPath)) return;
    await this.prisma.$executeRaw`
      UPDATE "documents"
         -- The ::int casts are load-bearing: Prisma binds a JS number as
         -- bigint, and there is no substring(text, bigint) overload, so
         -- without them this is a 42883 at runtime and never at compile time.
         SET "path"  = ${newPath} || substring("path" from ${oldPath.length + 1}::int),
             "depth" = "depth" + ${depthDelta}::int
       WHERE "workspace_id" = ${workspaceId}::uuid
         AND "path" LIKE ${`${oldPath}%`}
         AND "id" <> ${documentId}::uuid`;
  }

  /**
   * Renumber one sibling run to 0..n-1 in the given order, in one statement.
   *
   * It rewrites every row in the run rather than shifting a range, because the
   * run it inherits may already hold duplicate positions — nothing renumbered
   * on reparent before this route existed — and a shift preserves a collision
   * instead of resolving it. Moving a page is therefore also the repair.
   */
  private async renumberRun(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const positions = ids.map((_, i) => i);
    await this.prisma.$executeRaw`
      UPDATE "documents" AS d
         SET "position" = v."pos"
        FROM unnest(${ids}::uuid[], ${positions}::int[]) AS v("id", "pos")
       WHERE d."id" = v."id"`;
  }

  /**
   * Feature 32 (docs/features/32): place a page under a parent *and* among its
   * siblings, which is what a drag in the tree means.
   *
   * Separate from `updateDocument` because ordered placement is a multi-row
   * renumber rather than a scalar write: expressing it as a `position` field on
   * a partial update would make two concurrent drops each write an index
   * computed against a tree the other had already changed.
   */
  async moveDocument(documentId: string, dto: MoveDocumentDto, actorId?: string): Promise<DocumentSummary> {
    const document = await this.getDocumentOrThrow(documentId);
    const parentId = dto.parentId;

    if (parentId === documentId) throw new BadRequestException(t('error.document.selfParent'));

    // Same guard the update path uses, so a drop onto a page's own descendant
    // is refused by the server and not only by the dragging client.
    let newParent: { path: string; depth: number } | null = null;
    if (parentId !== null) newParent = await this.assertValidParent(documentId, parentId, document.projectId);

    const reparented = parentId !== document.parentId;
    const oldPath = document.path;
    const newPath = reparented ? `${newParent?.path ?? '/'}${documentId}/` : oldPath;
    const depthDelta = reparented ? (newParent?.depth ?? -1) + 1 - document.depth : 0;

    const updated = await this.prisma.withTransaction(async () => {
      // The destination run in the order the tree draws it, read inside the
      // transaction: that is what makes `beforeId` mean something. A sibling
      // that left between the client's copy of the tree and this call is a 409
      // the caller can act on, not a page quietly landing at the end.
      const siblings = await this.prisma.document.findMany({
        where: { projectId: document.projectId, parentId, id: { not: documentId } },
        orderBy: [{ position: 'asc' }, { title: 'asc' }],
        select: { id: true },
      });

      let index = siblings.length;
      if (dto.beforeId !== undefined && dto.beforeId !== null) {
        index = siblings.findIndex((s) => s.id === dto.beforeId);
        if (index === -1) {
          throw new ConflictException({
            statusCode: 409,
            message: t('error.document.siblingGone'),
            beforeId: dto.beforeId,
            parentId,
          });
        }
      }

      const ordered = siblings.map((s) => s.id);
      ordered.splice(index, 0, documentId);
      await this.renumberRun(ordered);

      // The run the page left keeps a hole otherwise. Ordering survives a hole,
      // but the next insert there would renumber around it anyway, so close it
      // now and keep the invariant true between calls rather than eventually.
      if (reparented) {
        const vacated = await this.prisma.document.findMany({
          where: { projectId: document.projectId, parentId: document.parentId, id: { not: documentId } },
          orderBy: [{ position: 'asc' }, { title: 'asc' }],
          select: { id: true },
        });
        await this.renumberRun(vacated.map((r) => r.id));
      }

      const row = await this.prisma.document.update({
        where: { id: documentId },
        data: reparented ? { parentId, path: newPath, depth: document.depth + depthDelta } : { parentId },
      });

      if (reparented) {
        await this.repathSubtree(document.workspaceId, documentId, oldPath, newPath, depthDelta);
        await this.permissions.recomputeRestrictedBy({ documentId });
      }
      return row;
    });

    await this.activity.record({
      workspaceId: document.workspaceId,
      actor: actorId,
      action: 'document.updated',
      documentId,
      metadata: { title: updated.title, changes: ['parentId', 'position'] },
      // Live patching: a tree open in another session moves the row rather than
      // refetching (docs/architecture/08-events-live.md).
      patch: { parentId: updated.parentId, position: updated.position },
    });
    return this.toSummary(updated);
  }

  /**
   * Feature 08 (docs/features/08): the document tree. Scoped to one project
   * when `projectId` is given; without it the tree spans the whole workspace,
   * which is what the web falls back to before its projects store resolves.
   */
  /**
   * The page tree, either whole or one level at a time.
   *
   * `depth` is what makes the tree lazy: without it the entire hierarchy is
   * built in memory as before, with it only `depth` levels below `parentId` are
   * fetched. A project with several hundred pages was sending all of them to
   * draw a rail showing six, and the cost fell on the first paint of every
   * route, because the sidebar loads the tree everywhere.
   *
   * Every node carries `childCount` regardless, so a row can draw its
   * disclosure chevron truthfully before anything under it exists.
   */
  async getTree(
    access: AccessScope,
    projectId?: string,
    opts: { parentId?: string | null; depth?: number; includeArchived?: boolean } = {},
  ): Promise<DocumentTreeResponse> {
    const { workspaceId } = access;
    // Archived pages leave the tree unless asked for (docs/features/39). A live
    // child of an archived parent then surfaces as a root, by the same orphan
    // rule legacy rows already use — nothing is hidden by accident.
    //
    // Pages the caller may not open are left out of every level, child counts
    // included (#76). A guest's granted page whose parent they cannot open then
    // surfaces as a root by that same orphan rule.
    const scope = {
      workspaceId,
      ...(projectId ? { projectId } : {}),
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      // A page that is still only a merge request joins the tree when it merges (#73).
      ...LISTED_PAGE,
      AND: [visibilityWhere(access)],
    };
    const lazy = typeof opts.depth === 'number';
    const parentId = opts.parentId ?? null;

    if (!lazy) {
      const docs = await this.prisma.document.findMany({
        where: scope,
        include: { branches: true },
        orderBy: [{ position: 'asc' }, { title: 'asc' }],
      });
      const issues = await this.provenance.openIssueCounts(docs.map((d) => d.id));
      const nodes = new Map<string, DocumentTreeNode>();
      for (const d of docs) nodes.set(d.id, this.toTreeNode(d, null, issues.get(d.id) ?? 0));
      const heads = await this.headStatuses(docs);
      for (const node of nodes.values()) node.headRevisionStatus = heads.get(node.headRevisionId ?? '') ?? null;

      const roots: DocumentTreeNode[] = [];
      for (const node of nodes.values()) {
        const parent = node.parentId ? nodes.get(node.parentId) : undefined;
        // Missing/legacy parents surface the child as a root — nothing is hidden.
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      for (const node of nodes.values()) node.childCount = node.children.length;
      return { workspaceId, projectId: projectId ?? null, parentId: null, roots };
    }

    const roots = await this.treeLevel(scope, parentId, Math.max(1, Math.floor(opts.depth!)));
    return { workspaceId, projectId: projectId ?? null, parentId, roots };
  }

  /**
   * One level of the tree, plus `depth - 1` levels beneath it.
   *
   * At the top level this also adopts orphans — children whose parent is not in
   * scope, which legacy rows and cross-project moves can produce. The eager
   * build has always surfaced those as roots, and a lazy walk that filtered on
   * `parentId: null` alone would make them unreachable instead.
   */
  private async treeLevel(
    scope: Prisma.DocumentWhereInput,
    parentId: string | null,
    depth: number,
  ): Promise<DocumentTreeNode[]> {
    let where: Prisma.DocumentWhereInput = { ...scope, parentId };
    if (parentId === null) {
      const referenced = await this.prisma.document.findMany({
        where: { ...scope, parentId: { not: null } },
        select: { parentId: true },
        distinct: ['parentId'],
      });
      const parentIds = referenced.map((r) => r.parentId!).filter(Boolean);
      const present = parentIds.length
        ? await this.prisma.document.findMany({
            where: { ...scope, id: { in: parentIds } },
            select: { id: true },
          })
        : [];
      const presentIds = new Set(present.map((p) => p.id));
      const orphaned = parentIds.filter((id) => !presentIds.has(id));
      where = orphaned.length
        ? { ...scope, OR: [{ parentId: null }, { parentId: { in: orphaned } }] }
        : { ...scope, parentId: null };
    }

    const docs = await this.prisma.document.findMany({
      where,
      include: { branches: true },
      orderBy: [{ position: 'asc' }, { title: 'asc' }],
    });
    if (docs.length === 0) return [];

    const [heads, counts, issues] = await Promise.all([
      this.headStatuses(docs),
      this.prisma.document.groupBy({
        by: ['parentId'],
        where: { ...scope, parentId: { in: docs.map((d) => d.id) } },
        _count: { _all: true },
      }),
      this.provenance.openIssueCounts(docs.map((d) => d.id)),
    ]);
    const countByParent = new Map(counts.map((c) => [c.parentId!, c._count._all]));

    const nodes = docs.map((d) => {
      const node = this.toTreeNode(d, countByParent.get(d.id) ?? 0, issues.get(d.id) ?? 0);
      node.headRevisionStatus = heads.get(node.headRevisionId ?? '') ?? null;
      return node;
    });

    if (depth > 1) {
      await Promise.all(
        nodes
          .filter((n) => n.childCount > 0)
          .map(async (n) => {
            n.children = await this.treeLevel(scope, n.documentId, depth - 1);
          }),
      );
    }
    return nodes;
  }

  private toTreeNode(
    d: Document & { branches: { name: string; headRevisionId: string | null }[] },
    childCount: number | null,
    openIssues: number,
  ): DocumentTreeNode {
    const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
    return {
      documentId: d.id,
      workspaceId: d.workspaceId,
      projectId: d.projectId,
      title: d.title,
      defaultBranch: d.defaultBranch,
      category: d.category as DocumentCategory,
      parentId: d.parentId,
      headRevisionId: headId,
      headRevisionStatus: null,
      createdAt: d.createdAt.toISOString(),
      // What a tree row draws (docs/features/39): the status dot and whether
      // the page is put away. The rest of the trust fields are the detail's.
      verification: verificationStateFor(d, headId, openIssues),
      verificationFlag: (d.verificationFlag as VerificationFlag | null) ?? null,
      ownerId: d.ownerId,
      archivedAt: d.archivedAt?.toISOString() ?? null,
      restricted: d.restrictedBy.length > 0,
      draftOwnerId: d.draftOwnerId,
      children: [],
      childCount: childCount ?? 0,
    };
  }

  private async headStatuses(
    docs: { defaultBranch: string; branches: { name: string; headRevisionId: string | null }[] }[],
  ): Promise<Map<string, RevisionStatus>> {
    const headIds = docs
      .map((d) => d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId)
      .filter((id): id is string => !!id);
    if (headIds.length === 0) return new Map();
    const heads = await this.prisma.documentRevision.findMany({
      where: { id: { in: headIds } },
      select: { id: true, status: true },
    });
    return new Map(heads.map((r) => [r.id, r.status as RevisionStatus]));
  }

  /**
   * The ancestor chain of a document, root first.
   *
   * Walked up rather than down, and bounded: `parentId` carries no FK (so a
   * legacy row can point at a deleted page) and moves are cycle-checked only on
   * the way in, so a corrupt chain must terminate rather than spin.
   */
  async getAncestors(documentId: string, scope: AccessScope): Promise<DocumentAncestorsResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const chain: DocumentSummary[] = [];
    const seen = new Set<string>([documentId]);
    let parentId = document.parentId;

    while (parentId && !seen.has(parentId) && chain.length < 32) {
      seen.add(parentId);
      const parent = await this.prisma.document.findUnique({
        where: { id: parentId },
        include: { branches: true },
      });
      // A parent outside the workspace is not an ancestor anyone may see.
      if (!parent || parent.workspaceId !== document.workspaceId) break;
      const headId = parent.branches.find((b) => b.name === parent.defaultBranch)?.headRevisionId ?? null;
      const head = headId
        ? await this.prisma.documentRevision.findUnique({ where: { id: headId }, select: { status: true } })
        : null;
      // Only a guest can open a page without opening what is above it (a
      // member who passes a page's restrictions passes its ancestors' too), and
      // what they were not granted is a placeholder: its id, nothing else (#76).
      const hidden = !canSee(scope, parent);
      chain.push({
        documentId: parent.id,
        workspaceId: parent.workspaceId,
        projectId: parent.projectId,
        title: hidden ? '' : parent.title,
        defaultBranch: parent.defaultBranch,
        category: hidden ? 'other' : (parent.category as DocumentCategory),
        parentId: parent.parentId,
        headRevisionId: hidden ? null : headId,
        headRevisionStatus: hidden ? null : ((head?.status as RevisionStatus) ?? null),
        createdAt: parent.createdAt.toISOString(),
        restricted: parent.restrictedBy.length > 0,
        ...(hidden ? { hidden: true } : {}),
      });
      parentId = parent.parentId;
    }

    return { documentId, ancestors: chain.reverse() };
  }

  /**
   * The whole workspace projected as one graph, for the pages landing.
   *
   * `getDocumentGraph` answers "what surrounds this page"; this answers "what
   * is in here at all", so there is no BFS and no root — every document in
   * scope is a node whether or not anything links to it, because an orphan
   * page the reader cannot see is a page they will never fix.
   *
   * Scoping to a project filters *documents*, then keeps only the entities
   * those documents still reach: an entity whose every mention lives in
   * another project is not part of this project's vocabulary.
   */
  async getWorkspaceGraph(scope: AccessScope, projectId?: string, at?: TemporalPoint): Promise<WorkspaceGraphResponse> {
    const { workspaceId } = scope;
    // Pages the caller may not open are not nodes, so their edges go (below,
    // `inScope`) and with them every entity only they mention (#76).
    const docs = await this.prisma.document.findMany({
      where: { workspaceId, ...(projectId ? { projectId } : {}), AND: [visibilityWhere(scope)] },
      include: { branches: true },
      orderBy: { title: 'asc' },
    });
    const inScope = new Set(docs.map((d) => d.id));

    const headIds = docs
      .map((d) => d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId)
      .filter((id): id is string => !!id);
    const heads = await this.prisma.documentRevision.findMany({
      where: { id: { in: headIds } },
      select: { id: true, status: true },
    });
    const statusById = new Map(heads.map((r) => [r.id, r.status as RevisionStatus]));

    // `inScope` is the authority (it is PG under the same predicate); the
    // graph filter only keeps hidden pages' edges off the wire (#76).
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId, await this.permissions.documentFilterFor(scope), at);

    // The renderer draws every edge each frame; past this the canvas stops
    // being readable long before it stops being fast, so the cap is a
    // legibility decision reported to the client rather than a silent slice.
    const kept = g.edges.filter((e) => inScope.has(e.documentId));
    const truncated = kept.length > WORKSPACE_GRAPH_MAX_EDGES;
    const edges: DocumentGraphEdge[] = kept.slice(0, WORKSPACE_GRAPH_MAX_EDGES).map((e) => ({
      from: e.documentId,
      to: e.targetKey,
      type: e.type,
      extractor: e.extractor,
      confidence: e.confidence,
    }));

    const degree = new Map<string, number>();
    const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
    for (const e of edges) {
      bump(e.from);
      bump(e.to);
    }

    const nodes: WorkspaceGraphNode[] = docs.map((d) => {
      const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
      return {
        id: d.id,
        kind: 'document' as const,
        label: d.title,
        category: d.category as DocumentCategory,
        status: headId ? (statusById.get(headId) ?? null) : null,
        degree: degree.get(d.id) ?? 0,
      };
    });
    for (const key of new Set(edges.map((e) => e.to))) {
      nodes.push({
        id: key,
        kind: 'entity',
        label: g.entities[key]?.name ?? key,
        entityType: g.entities[key]?.type ?? 'entity',
        layer: entityLayerFor(key),
        degree: degree.get(key) ?? 0,
      });
    }

    return { workspaceId, projectId: projectId ?? null, nodes, edges, truncated };
  }

  /**
   * Feature 06 (docs/features/06): the document neighbourhood in the
   * knowledge graph. depth = entity hops (one entity hop = two BFS hops over
   * the bipartite doc→entity graph, same convention as Phase 4 traversal).
   */
  async getDocumentGraph(documentId: string, depth: number, scope: AccessScope, at?: TemporalPoint): Promise<DocumentGraphResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const d = Math.min(Math.max(Math.floor(depth) || 1, 1), 3);

    // Walk only what the caller may open: an edge from a page they cannot see
    // would otherwise both reveal the page and carry the walk on through it
    // to entities only it mentions. GraphService drops both (#76).
    const g = await this.graph.getWorkspaceRelationGraph(document.workspaceId, await this.permissions.documentFilterFor(scope), at);
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
        layer: entityLayerFor(key),
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
  /**
   * "Platform / Billing / Invoices" for each id, ancestors only.
   *
   * Two queries whatever the input size: the ancestor ids are already sitting
   * in each row's `path`, so finding them costs no walk at all — which is what
   * makes it cheap enough to attach to every search result.
   *
   * A page whose ancestor left the workspace is named by the ancestors that
   * remain rather than dropped; the trail is a reading aid, not an ACL.
   */
  async breadcrumbsFor(scope: AccessScope, ids: string[]): Promise<Map<string, string>> {
    const { workspaceId } = scope;
    const out = new Map<string, string>();
    if (ids.length === 0) return out;

    const rows = await this.prisma.document.findMany({
      where: { workspaceId, id: { in: [...new Set(ids)] } },
      select: { id: true, path: true },
    });
    const ancestorIds = new Set<string>();
    for (const r of rows) {
      for (const id of r.path.split('/')) {
        if (id && id !== r.id) ancestorIds.add(id);
      }
    }
    if (ancestorIds.size === 0) {
      for (const r of rows) out.set(r.id, '');
      return out;
    }

    // An ancestor the caller may not open — only ever a guest's — leaves the
    // trail rather than naming itself in it (#76).
    const titles = new Map(
      (
        await this.prisma.document.findMany({
          where: { workspaceId, id: { in: [...ancestorIds] }, AND: [visibilityWhere(scope)] },
          select: { id: true, title: true },
        })
      ).map((a) => [a.id, a.title]),
    );
    for (const r of rows) {
      const trail = r.path
        .split('/')
        .filter((id) => id && id !== r.id)
        .map((id) => titles.get(id))
        .filter((title): title is string => Boolean(title));
      out.set(r.id, trail.join(' / '));
    }
    return out;
  }

  private async assertValidParent(
    documentId: string,
    parentId: string,
    projectId: string,
  ): Promise<{ path: string; depth: number }> {
    const parent = await this.prisma.document.findUnique({
      where: { id: parentId },
      select: { projectId: true, path: true, depth: true },
    });
    if (!parent || parent.projectId !== projectId) {
      throw new BadRequestException(t('error.document.parentNotInProject', { id: parentId }));
    }
    // A cycle is exactly "the proposed parent already sits below me", which the
    // parent's own path answers. This replaced an upward walk of up to 32
    // queries; the `seen` set and the hop bound went with it, because a string
    // comparison cannot spin the way a walk over a corrupt chain could.
    if (parent.path.includes(`/${documentId}/`)) {
      throw new BadRequestException(t('error.document.moveCycle'));
    }
    return { path: parent.path, depth: parent.depth };
  }

  /**
   * Every document below `documentId` in the tree.
   *
   * One indexed prefix match. This used to load every document in the
   * workspace and BFS them in Node, which the `path` column makes a second
   * answer to a question the database can now answer directly.
   */
  private async descendantIds(documentId: string, workspaceId: string): Promise<string[]> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { path: true },
    });
    // A row written by an older image carries the `/pending/` sentinel rather
    // than a real path (see 20260918090000_documents_path_rollback_safe). It
    // shares that string with every other such row, so a prefix match would
    // claim them as descendants. It has none until its path is repaired.
    if (!doc || !hasRealPath(doc.path)) return [];
    const rows = await this.prisma.document.findMany({
      where: { workspaceId, path: { startsWith: doc.path }, id: { not: documentId } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async toSummary(d: Document): Promise<DocumentSummary> {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId: d.id, name: d.defaultBranch } },
    });
    const head = branch?.headRevisionId
      ? await this.prisma.documentRevision.findUnique({ where: { id: branch.headRevisionId } })
      : null;
    const [issues, settings] = await Promise.all([
      this.provenance.openIssueCounts([d.id]),
      this.policy.effective(d.workspaceId),
    ]);
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
      ...this.trustFields(d, branch?.headRevisionId ?? null, issues.get(d.id) ?? 0, settings.inactiveAfterDays),
    };
  }

  /**
   * The REST relations payload, folded the same way frontmatter is.
   *
   * This used to pass `r.target.key` through verbatim, so `POST /:id/relations`
   * was a fourth way into the graph that could mint `Сервис:Биллинг` next to
   * the `сервис:биллинг` the ingest path had already canonicalized. The DTO is
   * validated, not normalized — those are different jobs.
   */
  private toFacts(relations: RelationInputDto[]) {
    return relations.flatMap((r) => {
      const target = normalizeRelationTarget({
        key: r.target.key,
        type: r.target.type,
        name: r.target.name ?? r.target.key,
      });
      if (!target) return [];
      return [{ type: r.type, target, extractor: 'explicit' as const, confidence: 1 }];
    });
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
    opts: {
      branch?: string;
      message?: string;
      contentType?: string;
      authorId?: string;
      collab?: { draftId: string; snapshot: Uint8Array<ArrayBuffer> };
    },
  ): Promise<DocumentRevision> {
    const document = await this.getDocumentOrThrow(documentId);
    const branchName = opts.branch ?? document.defaultBranch;
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: branchName } },
    });
    if (!branch) throw new NotFoundException(t('error.branch.notFound', { name: branchName, documentId }));

    // `withTransaction`, not `$transaction` — see the note in finalizeRevision.
    // This is the FIRST place a merge deadlocks, before finalizeRevision is even
    // reached: creating a revision inserts a row whose FK to `document_branches`
    // takes a `KEY SHARE` lock on that branch row, and `MergeRequestsService.merge`
    // already holds it `FOR UPDATE` on the outer connection. A second connection
    // here waits for a lock that cannot be released until this call returns.
    const contentType = this.revisionContentType(document.kind, opts.contentType);
    return this.prisma.withTransaction(async () => {
      const max = await this.prisma.documentRevision.aggregate({
        where: { documentId },
        _max: { revisionNumber: true },
      });
      const revision = await this.prisma.documentRevision.create({
        data: {
          documentId,
          branchId: branch.id,
          revisionNumber: (max._max.revisionNumber ?? 0) + 1,
          contentType,
          s3Key: '',
          authorId: opts.authorId ?? AUTHOR_ID_STUB,
          message: opts.message,
          status: 'draft',
          collabDraftId: opts.collab?.draftId,
          collabSnapshot: opts.collab?.snapshot,
        },
      });
      const s3Key = this.storage.revisionObjectKey(
        document.workspaceId,
        documentId,
        revision.id,
        this.storage.sourceObjectName(contentType),
      );
      const updated = await this.prisma.documentRevision.update({
        where: { id: revision.id },
        data: { s3Key },
      });
      if (branch.headRevisionId) {
        await this.prisma.revisionParent.create({
          data: { revisionId: revision.id, parentRevisionId: branch.headRevisionId, parentOrder: 1 },
        });
      }
      return updated;
    });
  }

  /**
   * A new revision's content type. A page keeps what the caller asked for
   * (markdown by default). A spec (#78) is always stored under its kind's
   * `vnd` type, in the syntax the caller named — a merge or an MCP write that
   * says `text/markdown` cannot turn a spec revision into a page body, because
   * the kind, not the type, decides how it is parsed.
   */
  private revisionContentType(kind: string, requested?: string): string {
    if (!isStructuredKind(kind)) return requested ?? 'text/markdown';
    return structuredContentType(kind, (requested && apiSpecSyntaxOf(requested)) || 'yaml');
  }


  private async getDocumentOrThrow(documentId: string) {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    return doc;
  }

  private async getRevisionOrThrow(documentId: string, revisionId: string) {
    const rev = await this.prisma.documentRevision.findUnique({ where: { id: revisionId } });
    if (!rev || rev.documentId !== documentId) {
      throw new NotFoundException(t('error.revision.notFoundOnDocument', { revisionId, documentId }));
    }
    return rev;
  }
}
