import { EditingPolicyService } from '../auth/editing-policy.service.js';
import type { WriteAuthority } from './write-authority.js';
import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';
import { readPageSource } from '../common/frontmatter.js';
import type {
  BranchInfo,
  FactExtractor,
  CreateBranchResponse,
  MyDraftBranchResponse,
  MyLiveDraftResponse,
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
  DocumentBacklinksResponse,
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
import { sourceConnectorOf, sourceSyncOf } from './source-backed.js';
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
import { Prisma, type Document, type DocumentBranch, type DocumentRevision } from '@prisma/client';
import {
  DRAFT_BRANCH_PREFIX,
  entityLayerFor,
  isInactive,
  verificationStateFor,
  type SourceSyncHealth,
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
import { ReadCache, READ_CACHE_FAMILIES } from '../cache/read-cache.service.js';
import { ProjectCommitsService } from '../git/project-commits.service.js';
import { AUTHOR_ID_STUB } from '../activity/actor.js';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */

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

/** The page and, by default, its subtree, scoped to its workspace. A rollback-sentinel path means the page alone. */
export function subtreeWhere(document: { id: string; workspaceId: string; path: string }, includeDescendants = true) {
  const subtree = includeDescendants && hasRealPath(document.path);
  return {
    workspaceId: document.workspaceId,
    ...(subtree ? { OR: [{ id: document.id }, { path: { startsWith: document.path } }] } : { id: document.id }),
  };
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
    private readonly cache: ReadCache,
    private readonly commits: ProjectCommitsService,
    private readonly editing: EditingPolicyService,
  ) {}

  async createDocument(input: CreateDocumentDto, authorId?: string): Promise<CreateDocumentResponse>;
  /**
   * `headless`: the page's first content lands on a branch (a push, a capture,
   * a proposed page), so it gets no first draft on its default branch: nothing
   * would ever finalize that draft, and it would sit in the page's history (#741).
   */
  async createDocument(input: CreateDocumentDto, authorId: string, opts: { headless: true }): Promise<Pick<CreateDocumentResponse, 'documentId'>>;
  async createDocument(
    input: CreateDocumentDto,
    authorId: string = AUTHOR_ID_STUB,
    opts: { headless?: true } = {},
  ): Promise<CreateDocumentResponse | Pick<CreateDocumentResponse, 'documentId'>> {
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

    // `path` contains the row's own id, so the id is minted here rather than by
    // the column default — one insert instead of insert-then-update. The
    // `@default(uuid())` stays for anyone who does not go through this method.
    const id = randomUUID();
    // Unset is `workspace`: only the REST route and the MCP tool, where a
    // person is writing, default to `private` (#474). System writers keep
    // creating pages the workspace sees, without having to say so.
    const isPrivate = dto.visibility === 'private';

    // `withTransaction` so an outer boundary absorbs this one — see the note in
    // finalizeRevision. A raw `$transaction` here commits on its own connection
    // regardless of the caller, so an import or connector pull whose outer
    // boundary later rolled back still left the page durably created.
    const { document, revision } = await this.prisma.withTransaction(async () => {
      // The project's commit lock (#636) makes the slug's sibling check race-free,
      // and the parent and sibling count are read under it (#807): a parent read
      // first could move into a restricted page before the insert, leaving this
      // child with the old path and readable outside that page's grants.
      await this.commits.lock(dto.projectId);
      // Feature 08: nested creation — the parent must exist in the same project.
      let parent: { path: string; depth: number } | null = null;
      if (dto.parentId) {
        const row = await this.prisma.document.findUnique({ where: { id: dto.parentId } });
        if (!row || row.projectId !== dto.projectId) {
          throw new BadRequestException(t('error.document.parentNotInProject', { id: dto.parentId }));
        }
        parent = { path: row.path, depth: row.depth };
      }
      const position = await this.prisma.document.count({
        where: { projectId: dto.projectId, parentId: dto.parentId ?? null },
      });
      const document = await this.prisma.document.create({
        data: {
          id,
          workspaceId: dto.workspaceId,
          projectId: dto.projectId,
          title: dto.title,
          slug: await this.commits.uniqueSlug(dto.projectId, dto.parentId ?? null, id, dto.title),
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
        data: {
          documentId: document.id,
          name: 'main',
          headRevisionId: null,
          projectBranchId: await this.commits.projectBranch(document.projectId, 'main'),
        },
      });
      if (opts.headless) return { document, revision: null };
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
    if (revision && dto.content) {
      await this.storage.putObjectText(revision.s3Key, dto.content.text, contentType);
      const finalized = await this.finalizeRevision(document.id, revision.id);
      status = finalized.status;
    }

    void this.activity.record({
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
    });
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

    return revision ? { documentId: document.id, revisionId: revision.id, branch: 'main', status } : { documentId: document.id };
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
      // The rendered body is handed straight back to its author.
      await this.permissions.scopeForUser(authorId, dto.workspaceId),
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
    by: WriteAuthority,
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
      revision = await this.createDraftRevision(documentId, { contentType: dto.contentType, authorId, by });
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
    /** Who vouches for the write (#958): a person's edit is held to the publish mode. */
    by: WriteAuthority,
    expectedHeadRevisionId?: string,
    authorId: string = AUTHOR_ID_STUB,
    /** The `web` connector writing its own source-backed page (#674); never from a request. */
    writer?: { connectorId: string },
  ): Promise<RevisionInfo> {
    return toRevisionInfo(await this.openDraft(documentId, dto, by, expectedHeadRevisionId, authorId, writer));
  }

  /**
   * Inline content as a new revision (#811): draft on the branch head, put the
   * bytes, finalize — one boundary, so a refused finalize leaves no draft behind
   * and a caller's own transaction absorbs all three. The one writer of inline
   * revision content; a moved head is `createRevision`'s 409. The MinIO PUT runs
   * inside, so a caller's boundary needs the raised timeout this one asks for.
   */
  async writeRevision(
    documentId: string,
    input: { text: string; branch?: string; message?: string; contentType?: string; expectedHeadRevisionId?: string },
    by: WriteAuthority,
    authorId: string = AUTHOR_ID_STUB,
    writer?: { connectorId: string },
  ): Promise<FinalizeRevisionResponse> {
    const { text, expectedHeadRevisionId, ...dto } = input;
    return this.prisma.withTransaction(
      async () => {
        const draft = await this.openDraft(documentId, dto, by, expectedHeadRevisionId, authorId, writer);
        await this.storage.putObjectText(draft.s3Key, text, draft.contentType);
        return this.finalizeRevision(documentId, draft.id);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  private async openDraft(
    documentId: string,
    dto: CreateRevisionDto,
    by: WriteAuthority,
    expectedHeadRevisionId: string | undefined,
    authorId: string,
    writer: { connectorId: string } | undefined,
  ): Promise<DocumentRevision> {
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

    return this.createDraftRevision(documentId, {
      branch: dto.branch,
      message: dto.message,
      // No default here: createDraftRevision picks one from the document's kind.
      contentType: dto.contentType,
      authorId,
      collab: dto.collabDraftId ? await this.draftOf(documentId, dto.branch ?? document.defaultBranch, dto) : undefined,
      connectorId: writer?.connectorId,
      by,
    });
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

  /**
   * `commit: false` leaves the project commit to the caller (#636): a merge
   * writes one commit for all of its pages, attributed to the person merging.
   * `dedupe: false` keeps a body equal to the branch head: "Update branch"
   * resolving a conflict in the branch's favour is still the merge node that
   * moves the merge base.
   */
  async finalizeRevision(
    documentId: string,
    revisionId: string,
    opts: { commit?: boolean; dedupe?: boolean } = {},
  ): Promise<FinalizeRevisionResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    this.assertNotArchived(document);
    const revision = await this.getRevisionOrThrow(documentId, revisionId);

    if (revision.status !== 'draft') {
      // Idempotent re-finalize: report current state.
      return { revisionId: revision.id, status: revision.status as RevisionStatus, ingestionJobId: null, deduplicated: false };
    }

    // One read (#818): the hashed bytes and the stored version are the same object.
    const stored = await this.storage.getObjectVersion(revision.s3Key);
    if (!stored) {
      throw new BadRequestException(t('error.document.uploadMissing', { key: revision.s3Key }));
    }
    const { text } = stored;
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

    // `withTransaction`, NOT `$transaction`: `$transaction` is in
    // NEVER_FROM_TRANSACTION, so under an outer boundary it opens a SECOND
    // transaction on a SECOND pooled connection instead of joining. That is a
    // deadlock, not an inefficiency — `MergeRequestsService.merge` holds
    // `document_branches ... FOR UPDATE` on the outer connection and this block
    // updates that same row, so the inner connection waits for a lock the outer
    // will not release until this call returns. Postgres sees the outer as
    // `idle in transaction` rather than blocked, so its deadlock detector never
    // fires and the request hangs until something kills the connection.
    //
    // Everything that decides the outcome is read or written after the lock
    // (#806): the status check above is only a fast path, and a second finalize
    // that waited on the lock (a double-click, a client or MCP retry) must find
    // the draft already claimed, not repeat the commit and the outbox row.
    const outcome = await this.prisma.withTransaction(async () => {
      await this.commits.lock(document.projectId);
      const claimed = await this.prisma.documentRevision.updateMany({
        where: { id: revision.id, status: 'draft' },
        data: {
          status: 'finalized',
          contentHash,
          s3VersionId: stored.versionId,
          finalizedAt: new Date(),
        },
      });
      if (claimed.count === 0) return { kind: 'current' as const, revision: await this.getRevisionOrThrow(documentId, revision.id) };

      // The branch this revision belongs to (branch_id, plan.md §4); legacy
      // rows without branchId fall back to the default branch.
      const branch = await this.prisma.documentBranch.findFirstOrThrow({
        where: revision.branchId ? { id: revision.branchId } : { documentId, name: document.defaultBranch },
        select: { id: true, name: true, headRevisionId: true, restricted: true },
      });

      // Content-hash idempotency (plan.md §4), against the branch head only
      // (#636): a body equal to the head is a no-op, while one equal to an older
      // revision is a revert and advances the head like any other edit. A merge
      // revision legitimately repeats the source head's content on the target
      // branch (plan.md §8), so another branch's revisions never count.
      const existing = branch.headRevisionId && opts.dedupe !== false
        ? await this.prisma.documentRevision.findFirst({ where: { id: branch.headRevisionId, contentHash } })
        : null;
      if (existing && existing.id !== revision.id) {
        await this.prisma.revisionParent.deleteMany({ where: { revisionId: revision.id } });
        await this.prisma.documentRevision.delete({ where: { id: revision.id } });
        // The draft says what `existing` says: it is published as that, with
        // no credit to write — `existing` keeps its own.
        if (revision.collabDraftId) await this.markPublished(revision.collabDraftId, existing.id, revision.collabSnapshot, false);
        return { kind: 'deduplicated' as const, revision: existing };
      }

      // The head moves only over a revision this draft descends from (#806).
      // Its parents were read from an unlocked head when it was drafted, so a
      // revision that landed since — another save, a merge — would otherwise
      // drop out of the head's lineage. A git push may parent a draft on its
      // second parent only, so "the head is any parent" is the rule, not
      // "the head is parent 1"; an empty branch has nothing to lose.
      const parents = (
        await this.prisma.revisionParent.findMany({
          where: { revisionId: revision.id },
          orderBy: { parentOrder: 'asc' },
          select: { parentRevisionId: true },
        })
      ).map((p) => p.parentRevisionId);
      const moved = await this.prisma.documentBranch.updateMany({
        where: { id: branch.id, OR: [{ headRevisionId: null }, { headRevisionId: { in: parents } }] },
        data: { headRevisionId: revision.id },
      });
      if (moved.count === 0) {
        const base = parents[0] ?? null;
        throw new ConflictException({
          statusCode: 409,
          message: t('error.branch.headMoved', { name: branch.name, actual: branch.headRevisionId ?? 'unset', expected: base ?? 'unset' }),
          currentHeadRevisionId: branch.headRevisionId,
          comparisonUrl: base && branch.headRevisionId
            ? `/v1/documents/${documentId}/compare?from=${base}&to=${branch.headRevisionId}&mode=merge-base`
            : null,
        });
      }
      if (revision.collabDraftId) await this.markPublished(revision.collabDraftId, revision.id, revision.collabSnapshot, true);
      if (opts.commit !== false) await this.commits.recordRevisions([revision.id]);
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
      return { kind: 'finalized' as const, job, privateBranch: branch.restricted };
    });
    if (outcome.kind !== 'finalized') {
      // Idempotent re-finalize, decided under the lock: report current state.
      // A deduplicated draft reports the head it matched.
      const { revision: r } = outcome;
      return { revisionId: r.id, status: r.status as RevisionStatus, ingestionJobId: null, deduplicated: outcome.kind === 'deduplicated' };
    }
    const { job, privateBranch } = outcome;

    // Both of these are post-commit by contract, and `onCommit` is what keeps
    // them so when a caller has wrapped this method in an outer transaction: the
    // inner `withTransaction` above then joins rather than commits, and enqueueing
    // here inline would hand the worker a job for an `ingestion_jobs` row that
    // has not committed — or never will, if the outer boundary rolls back.
    // Outside a transaction `onCommit` runs them immediately, so the un-wrapped
    // path is unchanged. Failures stay swallowed: the outbox sweeper re-enqueues,
    // and the event bus is best-effort.
    this.prisma.onCommit(() => this.ingestion.enqueue(job.id));
    // A revision on a private branch is nobody's news but its readers' (#474):
    // no feed row, no live frame, no watcher notification.
    if (!privateBranch) {
      void this.activity.record({
        workspaceId: document.workspaceId,
        actor: revision.authorId,
        action: 'revision.finalized',
        documentId,
        subjectId: revision.id,
        metadata: { title: document.title, revisionNumber: revision.revisionNumber },
      });
    }

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
    const [heads, issues, settings, sources] = await Promise.all([
      this.prisma.documentRevision.findMany({ where: { id: { in: headIds } } }),
      this.provenance.openIssueCounts(page.map((d) => d.id)),
      this.policy.thresholds(workspaceId),
      sourceSyncOf(this.prisma, page.map((d) => d.id)),
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
        ...this.trustFields(d, headId, issues.get(d.id) ?? 0, settings(d.projectId).inactiveAfterDays, sources.get(d.id)),
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
    source?: SourceSyncHealth,
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
    | 'childTemplateRef'
    | 'childTitlePattern'
    | 'restricted'
    | 'draftOwnerId'
  > {
    return {
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      verifiedBy: d.verifiedBy,
      verifiedRevisionId: d.verifiedRevisionId,
      verification: verificationStateFor({ ...d, source }, headId, openIssues),
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
      childTemplateRef: d.childTemplateRef,
      childTitlePattern: d.childTitlePattern,
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
      this.prisma.onCommit(() =>
        this.notifications.notify({
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
        }),
      );
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
    return this.withChunks(await this.getDocumentHead(documentId, revisionId));
  }

  /**
   * A page's detail without its chunks: PG only. Everything the full answer
   * depends on is in it — the chunks follow from the revision it names — so it
   * is also the validator of the conditional GET (#472): an unchanged page is a
   * 304 without the graph read.
   */
  async getDocumentHead(documentId: string, revisionId?: string): Promise<Omit<DocumentDetailResponse, 'chunks'>> {
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

    const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
    // An open report flags the page (docs/features/38, phase 3) — the same
    // predicate ProvenanceService applies to a cited source.
    const [issues, settings, sources] = await Promise.all([
      this.provenance.openIssueCounts([documentId]),
      this.policy.effectiveFor(document.workspaceId, document.projectId),
      sourceSyncOf(this.prisma, [documentId]),
    ]);
    const source = sources.get(documentId);
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
        sourceBacked: !!source,
        sourceSync: source ? { host: source.host, checkedAt: source.lastPulledAt ? new Date(source.lastPulledAt).toISOString() : null } : null,
        // The stamp, the flag and their reading against the head and the
        // clock (docs/features/38 + 39). Writes live in VerificationService.
        ...this.trustFields(document, headId, issues.get(documentId) ?? 0, settings.inactiveAfterDays, source),
      },
      revision: toRevisionInfo(revision),
    };
  }

  /** The graph half of `getDocument`: a revision's chunks, once it is indexed. */
  async withChunks(head: Omit<DocumentDetailResponse, 'chunks'>): Promise<DocumentDetailResponse> {
    const chunks =
      head.revision.status === 'indexed'
        ? (await this.graph.getRevisionChunkTexts(head.document.workspaceId, head.revision.revisionId)).map((c) => ({
            chunkId: c.chunkId,
            headingPath: c.headingPath,
            snippet: c.text.slice(0, 200),
          }))
        : [];
    return { ...head, chunks };
  }

  /**
   * A new branch off the default head or a finalized revision. `ownerId` is
   * who started it; `visibility: 'private'` (#474) restricts it to them, the
   * people they share it with and admins, and announces nothing — a
   * `branch.created` row would name it to every reader of the page.
   */
  async createBranch(documentId: string, dto: CreateBranchDto, ownerId?: string): Promise<CreateBranchResponse> {
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

    const isPrivate = dto.visibility === 'private';
    const branch = await this.prisma.documentBranch.create({
      data: {
        documentId,
        name: dto.name,
        headRevisionId: head,
        ownerId: ownerId ?? null,
        restricted: isPrivate,
        projectBranchId: await this.commits.projectBranch(document.projectId, dto.name),
      },
    });
    if (isPrivate) return { branch: this.toBranchInfo(branch) };
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: ownerId,
      action: 'branch.created',
      documentId,
      subjectId: branch.id,
      metadata: { title: document.title, branch: dto.name },
    });
    return { branch: this.toBranchInfo(branch) };
  }

  /**
   * The caller's working branch for this page (#474), private and created on
   * first ask. It is one branch per person and project (#636): a page not yet
   * on it forks onto the caller's newest live `draft/<userId>[-n]` at the
   * default head, so one Publish carries every page they edited. A draft an MR
   * was merged or closed from is spent, on every page — the MR made it
   * readable — so the next edit starts the next `-<n>`. A page branch nothing
   * was written on follows the default head, so the editor never opens a page
   * as it read the day the branch was cut. `pages` lists the pages the draft
   * has revisions on, for "Publish N pages".
   */
  async myDraftBranch(documentId: string, userId: string): Promise<MyDraftBranchResponse> {
    const document = await this.getDocumentOrThrow(documentId);
    const prefix = `${DRAFT_BRANCH_PREFIX}${userId}`;
    const spentMr = { status: { in: ['merged', 'closed'] } };
    const spent = { mrAsSource: { some: spentMr } };
    // This page's own live draft first, so work saved before the fold stays
    // where it is even when a newer draft exists.
    const mine = await this.liveDraftBranch(documentId, userId);
    if (!mine) {
      // Only a draft every page branch of which is the caller's: anyone may
      // name a branch `draft/<someone>`, and folding into theirs would publish
      // their pages under this person's Publish.
      const live = await this.prisma.projectBranch.findFirst({
        where: {
          projectId: document.projectId,
          name: { startsWith: prefix },
          branches: { some: { ownerId: userId }, every: { ownerId: userId }, none: spent },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true },
      });
      let name = live?.name;
      if (!name) {
        // The first name free in the whole project (#636): a branch name is the
        // project's, so reusing one another page spent or holds would join its branch.
        const held = await this.prisma.projectBranch.findMany({
          where: { projectId: document.projectId, name: { startsWith: prefix } },
          select: { name: true },
        });
        const own = await this.prisma.documentBranch.findMany({ where: { documentId, name: { startsWith: prefix } }, select: { name: true } });
        const taken = new Set([...held, ...own].map((b) => b.name));
        name = prefix;
        for (let n = 2; taken.has(name); n++) name = `${prefix}-${n}`;
      }
      // A draft already in review is readable to the page's readers on every
      // page it spans, so a page joining it is too.
      const inReview =
        !!live && (await this.prisma.mergeRequest.count({ where: { status: 'open', sourceBranch: { projectBranchId: live.id } } })) > 0;
      try {
        const created = await this.createBranch(documentId, { name, visibility: inReview ? 'workspace' : 'private' }, userId);
        return { ...created, pages: live ? await this.draftPages({ id: created.branch.branchId, projectBranchId: live.id }) : [] };
      } catch (e) {
        // Two of the caller's tabs asked in the same instant: the unique
        // (document, name) let one insert win, and that one is the answer.
        const lost =
          (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') || e instanceof ConflictException;
        if (!lost) throw e;
        return this.myDraftBranch(documentId, userId);
      }
    }
    const def = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: document.defaultBranch } },
      select: { headRevisionId: true },
    });
    if (def?.headRevisionId && def.headRevisionId !== mine.headRevisionId) {
      // ponytail: a shared draft opened but never saved keeps its stale base; the
      // publish then asks to review the newer head. Reset such drafts here if
      // that shows up as confusion.
      const [own, drafts] = await Promise.all([
        this.prisma.documentRevision.count({ where: { branchId: mine.id } }),
        this.prisma.collabDraft.count({ where: { branchId: mine.id } }),
      ]);
      if (own === 0 && drafts === 0) {
        const moved = await this.prisma.documentBranch.update({ where: { id: mine.id }, data: { headRevisionId: def.headRevisionId } });
        return { branch: this.toBranchInfo(moved), pages: await this.draftPages(mine) };
      }
    }
    return { branch: this.toBranchInfo(mine), pages: await this.draftPages(mine) };
  }

  /** The caller's working branch on this page that no merged or closed MR has spent. */
  private liveDraftBranch(documentId: string, userId: string): Promise<DocumentBranch | null> {
    const spentMr = { status: { in: ['merged', 'closed'] } };
    return this.prisma.documentBranch.findFirst({
      where: {
        documentId,
        ownerId: userId,
        name: { startsWith: `${DRAFT_BRANCH_PREFIX}${userId}` },
        mrAsSource: { none: spentMr },
        OR: [{ projectBranchId: null }, { projectBranch: { branches: { none: { mrAsSource: { some: spentMr } } } } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The read half of `myDraftBranch` (#958): the caller's working branch only
   * when work was saved or typed on it, and never created. What a `direct`
   * workspace's editor asks, so switching the mode strands nobody's draft.
   */
  async myLiveDraft(documentId: string, userId: string): Promise<MyLiveDraftResponse> {
    await this.getDocumentOrThrow(documentId);
    const mine = await this.liveDraftBranch(documentId, userId);
    if (!mine) return { branch: null, pages: [] };
    const [own, drafts] = await Promise.all([
      this.prisma.documentRevision.count({ where: { branchId: mine.id } }),
      this.prisma.collabDraft.count({ where: { branchId: mine.id } }),
    ]);
    return own + drafts > 0 ? { branch: this.toBranchInfo(mine), pages: await this.draftPages(mine) } : { branch: null, pages: [] };
  }

  /** The pages a working branch has revisions on (#636), by id: what its Publish would carry. */
  private async draftPages(branch: Pick<DocumentBranch, 'id' | 'projectBranchId'>): Promise<string[]> {
    const rows = await this.prisma.documentBranch.findMany({
      where: {
        ...(branch.projectBranchId ? { projectBranchId: branch.projectBranchId } : { id: branch.id }),
        revisions: { some: { status: { not: 'draft' } } },
      },
      select: { documentId: true },
      orderBy: { documentId: 'asc' },
    });
    return rows.map((r) => r.documentId);
  }

  /** The page's branches `scope` may read: a private one only for its owner, its grantees and admins (#474). */
  async listBranches(documentId: string, scope: AccessScope): Promise<ListBranchesResponse> {
    await this.getDocumentOrThrow(documentId);
    const [branches, visible] = await Promise.all([
      this.prisma.documentBranch.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } }),
      this.permissions.visibleBranchIds(scope, documentId),
    ]);
    return { branches: branches.filter((b) => visible.has(b.id)).map((b) => this.toBranchInfo(b)) };
  }

  /**
   * The revision DAG, or one branch of it. Revisions on a private branch
   * `scope` may not read are left out (#474); naming such a branch is refused
   * before this runs (the guard, or the MCP tool's).
   */
  async listRevisions(documentId: string, scope: AccessScope, branchName?: string): Promise<ListRevisionsResponse> {
    await this.getDocumentOrThrow(documentId);
    const visible = await this.permissions.visibleBranchIds(scope, documentId);

    let branchId: string | undefined;
    if (branchName) {
      const branch = await this.prisma.documentBranch.findUnique({
        where: { documentId_name: { documentId, name: branchName } },
      });
      if (!branch) throw new NotFoundException(t('error.branch.notFound', { name: branchName, documentId }));
      branchId = branch.id;
    }

    const revisions = await this.prisma.documentRevision.findMany({
      where: {
        documentId,
        ...(branchId ? { branchId } : { OR: [{ branchId: null }, { branchId: { in: [...visible] } }] }),
      },
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
      actor,
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
      actor,
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
    return this.readContent(await this.contentRevision(documentId, revisionId));
  }

  /**
   * Which revision a content read would return: PG only. Content is immutable
   * per revision, so its id is the validator of the conditional GET (#472) —
   * an unchanged page is a 304 without the object-storage read.
   */
  async contentRevision(
    documentId: string,
    revisionId?: string,
  ): Promise<{ workspaceId: string; kind: string; revision: DocumentRevision }> {
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
    return { workspaceId: document.workspaceId, kind: document.kind, revision };
  }

  /** The object-storage half of `getContent`. */
  async readContent({
    workspaceId,
    kind,
    revision,
  }: {
    workspaceId: string;
    kind: string;
    revision: DocumentRevision;
  }): Promise<DocumentContentResponse> {
    // A finalized revision's bytes never change (contentRevision refuses a draft).
    const family = READ_CACHE_FAMILIES.content;
    const raw = await this.cache.wrap(workspaceId, family.key(revision.id), () => this.storage.getObjectText(revision.s3Key, revision.s3VersionId), family.ttlMs);
    const parsed = readPageSource(raw, kind);
    return {
      documentId: revision.documentId,
      revisionId: revision.id,
      contentType: revision.contentType,
      frontmatter: Object.keys(parsed.data).length > 0 ? parsed.data : null,
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
      await this.commits.lock(document.projectId);
      const { count } = await this.prisma.document.updateMany({
        where: { id: documentId, draftOwnerId: { not: null } },
        data: { draftOwnerId: null, restricted: false },
      });
      if (count === 0) return false;
      await this.prisma.accessGrant.deleteMany({
        where: { resourceType: 'document', resourceId: documentId, origin: 'manual' },
      });
      await this.permissions.recomputeRestrictedBy({ documentId });
      // A draft's revisions wrote no commit (#636): this one adds the page, and
      // whatever under it was waiting on it, at their heads.
      const subtree = await this.prisma.document.findMany({
        where: { ...subtreeWhere(document), archivedAt: null },
        select: { id: true },
      });
      await this.commits.recordState(
        document.projectId,
        subtree.map((d) => d.id),
        { actorId, message: `Publish ${document.slug ?? document.title}` },
      );
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

  /**
   * Features 07 + 08 (docs/features): rename, recategorize, move in the tree.
   * `scope` is the caller's: a move lands the page where they must be able to
   * create one (#1087).
   */
  async updateDocument(documentId: string, dto: UpdateDocumentDto, scope: AccessScope, actorId?: string): Promise<DocumentSummary> {
    const document = await this.getDocumentOrThrow(documentId);
    this.assertNotArchived(document);
    const projectChanged = dto.projectId !== undefined && dto.projectId !== document.projectId;
    if (projectChanged || (dto.parentId !== undefined && dto.parentId !== document.parentId)) {
      // A project move with no parent re-roots the page (below).
      const parentId = dto.parentId !== undefined ? dto.parentId : projectChanged ? null : document.parentId;
      await this.requireDestination(scope, projectChanged ? dto.projectId! : document.projectId, parentId);
    }

    // Ownership is its own act with its own event and notification
    // (docs/features/39). It commits with the rest of the patch, inside the
    // boundary below, so a rejected PATCH leaves the owner alone too (#658).
    const newOwner = dto.ownerId !== undefined && dto.ownerId !== document.ownerId ? dto.ownerId : undefined;

    const data: {
      title?: string;
      category?: string;
      parentId?: string | null;
      projectId?: string;
      reviewIntervalDays?: number | null;
      verificationExpiresAt?: Date | null;
      childTemplateRef?: string | null;
      childTitlePattern?: string | null;
    } = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.category !== undefined) data.category = dto.category;
    // A collection's rule (#716). The template must resolve in this workspace,
    // and is stored in its canonical spelling; a blank pattern clears it.
    if (dto.childTemplateRef !== undefined) {
      data.childTemplateRef =
        dto.childTemplateRef === null ? null : (await this.templates.resolve(document.workspaceId, dto.childTemplateRef)).ref;
    }
    if (dto.childTitlePattern !== undefined) data.childTitlePattern = dto.childTitlePattern?.trim() ? dto.childTitlePattern.trimStart() : null;
    if (dto.reviewIntervalDays !== undefined && dto.reviewIntervalDays !== document.reviewIntervalDays) {
      data.reviewIntervalDays = dto.reviewIntervalDays;
      // A stamped page's deadline moves with its interval, from the same
      // arithmetic VerificationService.verify uses.
      if (document.verifiedAt) {
        const settings = await this.policy.effectiveFor(document.workspaceId, document.projectId);
        data.verificationExpiresAt = expiryFor(document.verifiedAt, dto.reviewIntervalDays, settings.reviewIntervalDays);
      }
    }

    // Project move (Workspace > Project > Document). Cross-workspace moves are
    // out of scope: the S3 key layout, graph vertices and the fulltext index
    // are all keyed by workspace, so the target must be a sibling project.
    if (dto.projectId !== undefined && dto.projectId !== document.projectId) {
      await this.projects.requireProjectInWorkspace(dto.projectId, document.workspaceId);
      data.projectId = dto.projectId;
      // The old parent stays behind, so the moved document is re-rooted unless
      // the same call supplies a parent inside the target project.
      if (dto.parentId === undefined) data.parentId = null;
    }

    const targetProject = data.projectId ?? document.projectId;
    if (dto.parentId !== undefined) data.parentId = dto.parentId;
    // A call that only changes the owner ends here, once every other field has
    // been read: an early return dropped a move sent with an owner (#658).
    if (Object.keys(data).length === 0) {
      if (dto.ownerId === undefined) throw new BadRequestException(t('error.document.nothingToUpdate'));
      return newOwner !== undefined ? this.setOwner(documentId, newOwner, actorId) : this.toSummary(document);
    }

    // One boundary around the row, its subtree's paths and the subtree's
    // project. The subtree re-project used to sit outside any explicit
    // transaction, so a failure between the two left children in a project
    // their parent had already left.
    const renamed = data.title !== undefined && data.title !== document.title;
    const placed = data.parentId !== undefined || data.projectId !== undefined;
    const updated = await this.prisma.withTransaction(async () => {
      // A rename or a move renames or moves the page's file (#636): a fresh
      // slug under its new parent, and one commit, under the commit lock. The
      // lock comes first and the page is read again under it (#807), so the
      // tree a move is checked against is the one it lands in.
      let row = document;
      let slug: string | undefined;
      if (renamed || placed) {
        row = await this.lockedDocument(document, targetProject);
        const parentAfter = data.parentId !== undefined ? data.parentId : row.parentId;
        slug = await this.commits.uniqueSlug(targetProject, parentAfter, documentId, data.title ?? row.title, row.slug);
      }
      if (newOwner !== undefined) await this.setOwner(documentId, newOwner, actorId);
      // A project move with no explicit parent re-roots the page (above), which
      // is a path change too.
      const reparented = data.parentId !== undefined && data.parentId !== row.parentId;
      const movedSubtree = data.projectId ? await this.descendantIds(documentId, document.workspaceId) : [];

      // Children follow their parent, otherwise they would be orphaned into a
      // project their ancestor no longer belongs to. Before the reparent, which
      // recomputes the subtree's restrictions from its new project.
      if (data.projectId && movedSubtree.length > 0) {
        await this.prisma.document.updateMany({
          where: { id: { in: movedSubtree } },
          data: { projectId: data.projectId },
        });
      }

      const fields = { ...data, ...(slug !== undefined ? { slug } : {}) };
      const updatedRow = reparented
        ? await this.reparent(row, data.parentId ?? null, targetProject, fields)
        : await this.prisma.document.update({ where: { id: documentId }, data: fields });

      // Their branches join the new project's branches of the same names.
      if (data.projectId) await this.commits.rehomeBranches(data.projectId);
      // A new project means a new chain of restrictions for the whole subtree,
      // in this transaction, so nobody reads the page in between with the old
      // ones (#76). `reparent` already did it for a move.
      if (!reparented && data.projectId) await this.permissions.recomputeRestrictedBy({ documentId });

      if (data.projectId) {
        // Gone from one project's tree, added to the other's, subtree and all.
        const moved = [documentId, ...movedSubtree];
        await this.commits.recordState(document.projectId, moved, { actorId, message: `Move ${slug} to another project`, removed: true });
        await this.commits.recordState(data.projectId, moved, { actorId, message: `Move ${slug} from another project` });
      } else if (slug !== undefined && (reparented || slug !== row.slug)) {
        const message = reparented ? `Move ${slug}` : `Rename ${row.slug ?? row.title} to ${slug}`;
        await this.commits.recordState(document.projectId, [documentId], { actorId, message });
      }
      // The BM25 rows carry the title (#528): the stale sweeper re-mirrors
      // them from the graph's chunks, with nothing re-embedded.
      if (renamed) {
        await this.prisma.documentRevision.updateMany({
          where: { documentId, status: 'indexed' },
          data: { fulltextStaleAt: new Date() },
        });
      }
      return updatedRow;
    });
    if (renamed) {
      // Keep the graph vertex label in sync (PG stays authoritative).
      await this.graph.upsertDocumentVertex(document.workspaceId, documentId, updated.title).catch(() => {
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
   * Take the project's commit lock (plus `also`), then read the page again
   * under it (#807). Every tree write starts here: a path, a depth or a parent
   * read before the lock may be a tree another writer has already changed,
   * which is how two crossed moves both passed the cycle check.
   *
   * A page that changed project before the lock was granted is held under the
   * wrong lock, so the write is refused rather than run.
   */
  private async lockedDocument(document: Document, ...also: string[]): Promise<Document> {
    await this.commits.lock(document.projectId, ...also);
    const row = await this.getDocumentOrThrow(document.id);
    if (row.projectId !== document.projectId) {
      throw new ConflictException({ statusCode: 409, message: t('error.document.projectChanged', { id: document.id }) });
    }
    return row;
  }

  /**
   * Put a page under `parentId` (null = the root): the self and cycle checks,
   * the row's path, depth and position, its subtree's paths and the subtree's
   * restrictions. The one sequence every mover runs (#807); three copies of it
   * are how their orderings drifted. Call under the project's commit lock, with
   * `row` read under it (`lockedDocument`).
   *
   * `position` defaults to the end of the new siblings. Keeping the old index
   * collided with whoever held it under the new parent, leaving the tie to be
   * broken by title, so a moved page appeared in an arbitrary slot.
   */
  private async reparent(
    row: Document,
    parentId: string | null,
    projectId: string,
    data: Prisma.DocumentUncheckedUpdateInput = {},
    position?: number,
  ): Promise<Document> {
    if (parentId === row.id) throw new BadRequestException(t('error.document.selfParent'));
    const parent = parentId ? await this.assertValidParent(row.id, parentId, projectId) : null;
    const path = `${parent?.path ?? '/'}${row.id}/`;
    const depthDelta = (parent?.depth ?? -1) + 1 - row.depth;
    position ??= await this.prisma.document.count({ where: { projectId, parentId, id: { not: row.id } } });
    const updated = await this.prisma.document.update({
      where: { id: row.id },
      data: { ...data, parentId, path, depth: row.depth + depthDelta, position },
    });
    await this.repathSubtree(row.workspaceId, row.id, row.path, path, depthDelta);
    // New ancestors mean a new chain of restrictions for the whole subtree, in
    // this transaction, so nobody reads the page in between with the old ones (#76).
    await this.permissions.recomputeRestrictedBy({ documentId: row.id });
    return updated;
  }

  /**
   * A moved page inherits its new chain's restrictions, so placing it is
   * creating it there (#1087): `requireCreateUnder`, asked before anything is
   * read about the destination, so a hidden parent or sibling answers exactly
   * as it does to create and the move cannot probe the tree. Without it an
   * editor could hide any page they edit, from everyone and themselves, by
   * moving it under a restricted one.
   */
  private async requireDestination(scope: AccessScope, projectId: string, parentId: string | null): Promise<void> {
    await this.permissions.requireCreateUnder(scope, { projectId, ...(parentId ? { parentId } : {}) });
  }

  /**
   * Re-point a moved page's descendants at its new path, in one statement for a
   * subtree of any size. Left-anchored LIKE, so the (workspace_id, path) index
   * serves it; the old upward walk could not express this at all.
   *
   * Only `reparent` calls this: the `substring` offset and the depth delta
   * have to agree with the path the row itself was given, and two copies of
   * that arithmetic is how a subtree ends up at a depth its own parent
   * disagrees with.
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
  async moveDocument(documentId: string, dto: MoveDocumentDto, scope: AccessScope, actorId?: string): Promise<DocumentSummary> {
    const document = await this.getDocumentOrThrow(documentId);
    const parentId = dto.parentId;
    if (parentId !== document.parentId) await this.requireDestination(scope, document.projectId, parentId);

    const updated = await this.prisma.withTransaction(async () => {
      // The lock first, even for a reorder, and the page read again under it
      // (#807). Two crossed moves checked against paths read before it both
      // passed the cycle check, and two drops into one run each renumbered it
      // from their own read.
      const row = await this.lockedDocument(document);
      const reparented = parentId !== row.parentId;

      // The destination run in the order the tree draws it, read inside the
      // transaction: that is what makes `beforeId` mean something. A sibling
      // that left between the client's copy of the tree and this call is a 409
      // the caller can act on, not a page quietly landing at the end.
      const siblings = await this.prisma.document.findMany({
        where: { projectId: row.projectId, parentId, id: { not: documentId } },
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

      if (!reparented) return { ...row, position: index };
      // The run the page left keeps a hole otherwise. Ordering survives a hole,
      // but the next insert there would renumber around it anyway, so close it
      // now and keep the invariant true between calls rather than eventually.
      const vacated = await this.prisma.document.findMany({
        where: { projectId: row.projectId, parentId: row.parentId, id: { not: documentId } },
        orderBy: [{ position: 'asc' }, { title: 'asc' }],
        select: { id: true },
      });
      await this.renumberRun(vacated.map((r) => r.id));

      // A reparent moves the page's file (#636): see updateDocument. The
      // parent check is the update path's, so a drop onto a page's own
      // descendant is refused by the server and not only by the dragging client.
      const slug = await this.commits.uniqueSlug(row.projectId, parentId, documentId, row.title, row.slug);
      const moved = await this.reparent(row, parentId, row.projectId, { slug }, index);
      await this.commits.recordState(row.projectId, [documentId], { actorId, message: `Move ${slug}` });
      return moved;
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
   * Put pages where a branch's tree puts them (#636 phase 4): a push to the
   * default branch, or a merge into it, moves, renames, archives and
   * unarchives them with the rules `moveDocument` applies — the parent in the
   * same project, the path cycle check, the subtree's paths and restrictions —
   * and writes no commit: the caller's commit records the result.
   *
   * Pages are placed shallowest first by where they end up, so a page moving
   * under one that moves too is placed after it, and a swap never passes
   * through a cycle. Run inside the caller's transaction, under its commit lock.
   */
  async applyPlaces(
    projectId: string,
    places: { documentId: string; parentDocumentId: string | null; slug: string; removed: boolean }[],
    actorId: string,
  ): Promise<string[]> {
    if (places.length === 0) return [];
    const docs = new Map((await this.prisma.document.findMany({ where: { id: { in: places.map((p) => p.documentId) } } })).map((d) => [d.id, d]));
    const wanted = new Map(places.map((p) => [p.documentId, p]));
    const parentOf = async (id: string): Promise<string | null> =>
      wanted.get(id)?.parentDocumentId ??
      (wanted.has(id) ? null : ((await this.prisma.document.findUnique({ where: { id }, select: { parentId: true } }))?.parentId ?? null));
    const depthOf = async (id: string): Promise<number> => {
      let depth = 0;
      for (let p = await parentOf(id); p && depth < 64; p = await parentOf(p)) depth++;
      return depth;
    };
    const order = await Promise.all(places.map(async (p) => ({ p, depth: await depthOf(p.documentId) })));
    order.sort((a, b) => a.depth - b.depth);

    const changed: string[] = [];
    for (const { p } of order) {
      const document = docs.get(p.documentId);
      if (!document || document.projectId !== projectId) continue;
      const row = await this.prisma.document.findUniqueOrThrow({ where: { id: p.documentId } });
      const data: Prisma.DocumentUncheckedUpdateInput = {};
      if (p.parentDocumentId !== row.parentId) await this.reparent(row, p.parentDocumentId, projectId);
      if (p.slug !== row.slug) data.slug = p.slug;
      if (p.removed !== (row.archivedAt !== null)) {
        data.archivedAt = p.removed ? new Date() : null;
        data.archivedBy = p.removed ? actorId : null;
      }
      if (Object.keys(data).length) await this.prisma.document.update({ where: { id: row.id }, data });
      if (p.parentDocumentId !== row.parentId || Object.keys(data).length) changed.push(row.id);
      if (p.removed !== (row.archivedAt !== null)) {
        const action = p.removed ? 'document.archived' : 'document.unarchived';
        void this.activity.record({ workspaceId: row.workspaceId, actor: actorId, action, documentId: row.id, projectId, metadata: { title: row.title, affected: 1, includeDescendants: false } });
      }
    }
    return changed;
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
      const [issues, sources] = await Promise.all([
        this.provenance.openIssueCounts(docs.map((d) => d.id)),
        sourceSyncOf(this.prisma, docs.map((d) => d.id)),
      ]);
      const nodes = new Map<string, DocumentTreeNode>();
      for (const d of docs) nodes.set(d.id, this.toTreeNode(d, null, issues.get(d.id) ?? 0, sources.get(d.id)));
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

    const [heads, counts, issues, sources] = await Promise.all([
      this.headStatuses(docs),
      this.prisma.document.groupBy({
        by: ['parentId'],
        where: { ...scope, parentId: { in: docs.map((d) => d.id) } },
        _count: { _all: true },
      }),
      this.provenance.openIssueCounts(docs.map((d) => d.id)),
      sourceSyncOf(this.prisma, docs.map((d) => d.id)),
    ]);
    const countByParent = new Map(counts.map((c) => [c.parentId!, c._count._all]));

    const nodes = docs.map((d) => {
      const node = this.toTreeNode(d, countByParent.get(d.id) ?? 0, issues.get(d.id) ?? 0, sources.get(d.id));
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
    source?: SourceSyncHealth,
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
      verification: verificationStateFor({ ...d, source }, headId, openIssues),
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
   * Pages whose default-branch head links to `documentId` (#673), optionally
   * only those linking to one `anchor`. Sources are read under the caller's
   * scope and the list predicate, in the target's workspace only: a page the
   * caller cannot open is absent, never counted.
   */
  async getBacklinks(documentId: string, scope: AccessScope, anchor?: string): Promise<DocumentBacklinksResponse> {
    const links = await this.prisma.pageLink.findMany({
      where: { workspaceId: scope.workspaceId, targetDocumentId: documentId, ...(anchor ? { targetAnchor: anchor } : {}) },
      select: { sourceDocumentId: true, targetAnchor: true },
    });
    const anchors = new Map<string, Set<string>>();
    for (const l of links) {
      const set = anchors.get(l.sourceDocumentId) ?? new Set<string>();
      if (l.targetAnchor) set.add(l.targetAnchor);
      anchors.set(l.sourceDocumentId, set);
    }
    if (anchors.size === 0) return { documentId, backlinks: [] };
    const sources = await this.prisma.document.findMany({
      where: {
        id: { in: [...anchors.keys()] },
        workspaceId: scope.workspaceId,
        archivedAt: null,
        ...LISTED_PAGE,
        AND: [visibilityWhere(scope)],
      },
      select: { id: true, title: true, projectId: true },
      orderBy: { title: 'asc' },
      // ponytail: unpaged, add a cursor when one page collects thousands of backlinks
    });
    return {
      documentId,
      backlinks: sources.map((d) => ({
        documentId: d.id,
        title: d.title,
        projectId: d.projectId,
        anchors: [...(anchors.get(d.id) ?? [])].sort(),
      })),
    };
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
    // `inScope`) and with them every entity only they mention (#76). A capture
    // still behind its merge request is not a node until it merges (#642).
    const docs = await this.prisma.document.findMany({
      where: { workspaceId, ...(projectId ? { projectId } : {}), ...LISTED_PAGE, AND: [visibilityWhere(scope)] },
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
    // A neighbour still behind its merge request is not a page yet (#642); the
    // page itself stays, so its reviewer can open its graph.
    const unlisted = new Set(
      (
        await this.prisma.document.findMany({
          where: { workspaceId: document.workspaceId, pendingMergeRequestId: { not: null }, id: { not: documentId } },
          select: { id: true },
        })
      ).map((d) => d.id),
    );
    const adj = buildAdjacency(g.edges.filter((e) => !unlisted.has(e.documentId)));
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
    const [issues, settings, sources] = await Promise.all([
      this.provenance.openIssueCounts([d.id]),
      this.policy.effectiveFor(d.workspaceId, d.projectId),
      sourceSyncOf(this.prisma, [d.id]),
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
      ...this.trustFields(d, branch?.headRevisionId ?? null, issues.get(d.id) ?? 0, settings.inactiveAfterDays, sources.get(d.id)),
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
      ownerId: b.ownerId,
      restricted: b.restricted,
      createdAt: b.createdAt.toISOString(),
    };
  }

  /**
   * The publish mode, enforced where every revision is created (#958). In a
   * `review` workspace a person adds a revision to the default branch of a
   * published page only by merging a merge request, unless they are a
   * workspace admin; in `direct` any editor may. Not a person's direct edit,
   * so never held: an `internalWrite`, a branch other than the default, a
   * private draft page (its author's until Publish) and the first revision of
   * a page that has none — but not of a page still behind its merge request,
   * whose first revision is that merge. The refusal carries a reason a client
   * branches on and no title.
   */
  private async assertMayWrite(
    document: Pick<Document, 'workspaceId' | 'defaultBranch' | 'draftOwnerId' | 'pendingMergeRequestId'>,
    branch: Pick<DocumentBranch, 'name' | 'headRevisionId'>,
    by: WriteAuthority,
  ): Promise<void> {
    if ('internal' in by || !by.person || by.person.mode === 'dev') return;
    if (branch.name !== document.defaultBranch || document.draftOwnerId) return;
    if (!branch.headRevisionId && !document.pendingMergeRequestId) return;
    if ((await this.editing.policy(document.workspaceId)).publishMode.effective === 'direct') return;
    if ((await this.permissions.scopeFor(by.person, document.workspaceId)).bypass) return;
    throw new ConflictException({ statusCode: 409, message: t('error.document.reviewRequired'), reason: 'review-required' });
  }

  /** `assertMayWrite` for a caller that writes several pages and must refuse before the first (a git push). */
  async assertMayWriteDirect(documentId: string, branchName: string, by: WriteAuthority): Promise<void> {
    const document = await this.getDocumentOrThrow(documentId);
    const branch = await this.prisma.documentBranch.findUnique({ where: { documentId_name: { documentId, name: branchName } } });
    if (branch) await this.assertMayWrite(document, branch, by);
  }

  private async createDraftRevision(
    documentId: string,
    opts: {
      branch?: string;
      message?: string;
      contentType?: string;
      authorId?: string;
      collab?: { draftId: string; snapshot: Uint8Array<ArrayBuffer> };
      connectorId?: string;
      by: WriteAuthority;
    },
  ): Promise<DocumentRevision> {
    const document = await this.getDocumentOrThrow(documentId);
    // A source-backed page (#674) takes revisions from its own connector and
    // from nobody else: every writer — editor, upload, MCP, git push, a merge,
    // a co-editing publish — creates its revision here, so this is the one
    // place the rule lives. A branch is refused too, or a merge would land it.
    const source = await sourceConnectorOf(this.prisma, documentId);
    if (source && source !== opts.connectorId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.sourceBacked', { title: document.title }),
        reason: 'source-backed',
      });
    }
    const branchName = opts.branch ?? document.defaultBranch;
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: branchName } },
    });
    if (!branch) throw new NotFoundException(t('error.branch.notFound', { name: branchName, documentId }));
    await this.assertMayWrite(document, branch, opts.by);

    // `withTransaction`, not `$transaction` — see the note in finalizeRevision.
    // This is the FIRST place a merge deadlocks, before finalizeRevision is even
    // reached: creating a revision inserts a row whose FK to `document_branches`
    // takes a `KEY SHARE` lock on that branch row, and `MergeRequestsService.merge`
    // already holds it `FOR UPDATE` on the outer connection. A second connection
    // here waits for a lock that cannot be released until this call returns.
    const contentType = this.revisionContentType(document.kind, opts.contentType);
    return this.prisma.withTransaction(async () => {
      // `max + 1` under the project's commit lock (#807): two saves reading the
      // same max hit the (document, revisionNumber) unique index, a 500. The
      // lock is the one every writer takes first, so a merge, which already
      // holds it, takes it again for free.
      await this.commits.lock(document.projectId);
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
