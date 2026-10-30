import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  DocumentContentResponse,
  CompareMode,
  CompareResponse,
  CreateBranchResponse,
  MyDraftBranchResponse,
  CreateDocumentResponse,
  CreateDocumentThreadResponse,
  CreateUploadResponse,
  DeleteDocumentCommentResponse,
  DocumentAncestorsResponse,
  DocumentConnectorResponse,
  DocumentDetailResponse,
  DocumentGraphResponse,
  DocumentSummary,
  DocumentThreadResponse,
  DocumentTreeResponse,
  FactsAtResponse,
  FactTimelineResponse,
  FinalizeRevisionResponse,
  GlossaryExclusion,
  ListBranchesResponse,
  ListDocumentRelationsResponse,
  ListDocumentsResponse,
  ListDocumentThreadsResponse,
  ListGlossaryExclusionsResponse,
  ListRevisionsResponse,
  ProposeRelationsResponse,
  PushDocumentResponse,
  RevisionInfo,
  WorkspaceGraphResponse,
} from '@knowledge/contracts';
import { ConnectorLinksService } from '../connectors/connector-links.service.js';
import { ConnectorProducer } from '../connectors/connector.producer.js';
import { ConnectorsService, toRunInfo } from '../connectors/connectors.service.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import { PermissionService } from '../permissions/permission.service.js';
import type { Principal } from '../auth/principal.js';
import { DocumentsService } from './documents.service.js';
import { DocumentRelationsService } from './document-relations.service.js';
import { HistoryService } from './history.service.js';
import { DocumentThreadsService } from './document-threads.service.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import { CreateGlossaryExclusionDto } from '../glossary/glossary.dto.js';
import { CompareService } from './compare.service.js';
import {
  AddRelationsDto,
  CreateBranchDto,
  CreateDocumentDto,
  CreateRevisionDto,
  CreateUploadDto,
  CurateRelationDto,
  MoveDocumentDto,
  ProposeRelationsDto,
  UpdateDocumentDto,
} from './dto/documents.dto.js';
import { CreateCommentDto, CreateThreadDto, ResolveThreadDto } from './dto/merge-requests.dto.js';
import { t } from '../i18n/t.js';
import { AiReadableService } from '../ai-readable/ai-readable.service.js';
import { sendPageMarkdown } from '../ai-readable/ai-readable.http.js';
import { prefersMarkdown, wantsFrontmatter } from '../ai-readable/render.js';
import { withAsOf } from '../graph/temporal.js';
import { ApiAsOfQuery } from '../temporal/temporal.dto.js';
import { TemporalResolverService } from '../temporal/temporal-resolver.service.js';
import { CommunitiesService } from '../communities/communities.service.js';
import { AnalyticsRecorder, noTrackOf } from '../analytics/analytics.recorder.js';
import { Returns } from '../common/returns.decorator.js';
import { notModified, setCachePolicy } from '../common/http-cache.js';

/** A query-string boolean: `1`, `true` and `yes` are on; anything else, including absence, is off. */
function flag(value?: string): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

/** Query facets arrive comma-separated; a singular alias folds in beside them. */
function csv(value?: string, single?: string): string[] {
  const parts = (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (single?.trim()) parts.push(single.trim());
  return [...new Set(parts)];
}

@ApiTags('documents')
@Controller('v1/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly relations: DocumentRelationsService,
    private readonly connectorLinks: ConnectorLinksService,
    private readonly connectorsService: ConnectorsService,
    private readonly connectorProducer: ConnectorProducer,
    private readonly compareService: CompareService,
    private readonly history: HistoryService,
    private readonly threads: DocumentThreadsService,
    private readonly glossary: GlossaryService,
    private readonly aiReadable: AiReadableService,
    private readonly permissions: PermissionService,
    private readonly temporal: TemporalResolverService,
    private readonly communities: CommunitiesService,
    private readonly analytics: AnalyticsRecorder,
  ) {}

  @Post()
  @Returns('CreateDocumentResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Create document (optionally inline content, auto-finalizes)' })
  async create(@Body() dto: CreateDocumentDto, @CurrentPrincipal() principal: Principal): Promise<CreateDocumentResponse> {
    // A page under a restricted node inherits it, so placing one there is
    // editing that node (#76) — and a hidden parent id cannot be probed by it.
    await this.permissions.requireCreateUnder(await this.permissions.scopeFor(principal, dto.workspaceId), {
      projectId: dto.projectId,
      ...(dto.parentId ? { parentId: dto.parentId } : {}),
    });
    // A person writing a page starts it private (#474) unless they say otherwise.
    return this.documents.createDocument({ ...dto, visibility: dto.visibility ?? 'private' }, principal?.userId);
  }

  @Get()
  @Returns('ListDocumentsResponse')
  // Guests too: the list is filtered to what they were granted (#76).
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'List documents in workspace, filtered by the search facets' })
  @ApiQuery({ name: 'limit', required: false, description: 'Rows per batch; 20 when omitted' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque cursor from a previous batch' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  @ApiQuery({ name: 'category', required: false, description: 'Restrict to one category' })
  @ApiQuery({ name: 'projectIds', required: false, description: 'Comma-separated project ids' })
  @ApiQuery({ name: 'categories', required: false, description: 'Comma-separated categories' })
  @ApiQuery({
    name: 'tags',
    required: false,
    description: 'Comma-separated frontmatter tags; bare name or `tag:` entity key',
  })
  @ApiQuery({ name: 'includeArchived', required: false, description: '1 to include archived pages (docs/features/39)' })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('category') category?: string,
    @Query('projectId') projectId?: string,
    @Query('categories') categories?: string,
    @Query('projectIds') projectIds?: string,
    @Query('tags') tags?: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<ListDocumentsResponse> {
    // The singular params predate the facets and still work; each is folded
    // into its plural so callers never have to know which one won.
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    return this.documents.listDocuments(scope, limit ? Number(limit) : 20, cursor, {
      categories: csv(categories, category),
      projectIds: csv(projectIds, projectId),
      tags: csv(tags),
      includeArchived: flag(includeArchived),
    });
  }

  @Get('tree')
  @Returns('DocumentTreeResponse')
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({
    summary: 'Document hierarchy (feature 08). Omit depth for the whole tree; pass depth=1 to walk it a level at a time',
  })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  @ApiQuery({ name: 'parentId', required: false, description: 'Children of this node; omit for the top level' })
  @ApiQuery({ name: 'depth', required: false, description: 'Levels to load below parentId; omit to load all of them' })
  @ApiQuery({ name: 'includeArchived', required: false, description: '1 to include archived pages (docs/features/39)' })
  async tree(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('projectId') projectId?: string,
    @Query('parentId') parentId?: string,
    @Query('depth') depth?: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<DocumentTreeResponse> {
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    return this.documents.getTree(scope, projectId || undefined, {
      parentId: parentId || null,
      ...(depth ? { depth: Number(depth) } : {}),
      includeArchived: flag(includeArchived),
    });
  }

  // Declared before @Get(':id') — 'graph' would otherwise parse as a document id.
  @Get('graph')
  @Returns('WorkspaceGraphResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Whole-workspace relation graph for the pages landing; scoped to one project when projectId is given' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict the graph to one project' })
  @ApiAsOfQuery()
  async workspaceGraph(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('projectId') projectId?: string,
    @Query('asOf') asOf?: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<WorkspaceGraphResponse> {
    const at = await this.temporal.resolve(workspaceId, asOf, knownAt);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const graph = await this.documents.getWorkspaceGraph(scope, projectId || undefined, at);
    // #81 phase 7: each page's community, for colouring — the current graph's
    // grouping, so not on an as-of read.
    if (!at) {
      const community = await this.communities.membership(scope);
      if (community.size) for (const n of graph.nodes) if (n.kind === 'document' && community.has(n.id)) n.community = community.get(n.id);
    }
    return withAsOf(graph, at);
  }

  @Get(':id')
  @Returns('DocumentDetailResponse', { conditional: true })
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Get document + its head (or given) revision + chunk summaries' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('revision') revision?: string,
  ): Promise<DocumentDetailResponse | undefined> {
    // The same for every reader the guard admits, so no scope in the validator.
    const head = await this.documents.getDocumentHead(id, revision);
    if (notModified(req, res, head)) return undefined;
    return this.documents.withChunks(head);
  }

  @Patch(':id')
  @Returns('DocumentSummary')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Update title / category / parent (features 07 + 08); parentId: null re-roots' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentSummary> {
    return this.documents.updateDocument(id, dto, principal?.userId);
  }

  @Post(':id/move')
  @Returns('DocumentSummary')
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Feature 32: place a page under a parent and among its siblings in one call. ' +
      'parentId: null re-roots; beforeId names the sibling it lands above, omitted appends last',
  })
  @ApiResponse({ status: 409, description: 'beforeId no longer names a child of parentId — the tree moved' })
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentSummary> {
    return this.documents.moveDocument(id, dto, principal?.userId);
  }

  @Post(':id/publish')
  @Returns('DocumentDetailResponse')
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Open a private draft to the workspace (#474): lifts its restriction and drops the grants it was shared with; ' +
      'it keeps its parent\'s and project\'s restrictions. Needs manage on the page. A no-op on a published page',
  })
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentDetailResponse> {
    await this.permissions.requireLevel(
      await this.permissions.scopeForDocument(principal, id),
      { type: 'document', id },
      'manage',
    );
    return this.documents.publishDraft(id, principal.userId);
  }

  // `:id/verify`, `:id/verification-request`, `:id/outdated`, `:id/archive` and
  // `:id/unarchive` live in VerificationController (docs/features/39), mounted
  // on the same prefix.

  @Get(':id/content')
  @Returns('DocumentContentResponse', { orText: true })
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Full raw content of a revision (feature 01; head of the default branch by default)' })
  @ApiQuery({ name: 'revision', required: false })
  @ApiQuery({ name: 'frontmatter', required: false, description: 'With Accept: text/markdown, 1 to include the YAML block' })
  @ApiAsOfQuery()
  @ApiHeader({
    name: 'Accept',
    required: false,
    description: 'text/markdown (ranked above application/json) answers with the same body as GET :id/markdown (issue #68)',
  })
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('revision') revision?: string,
    @Query('frontmatter') frontmatter?: string,
    @Query('asOf') asOf?: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<DocumentContentResponse | string | undefined> {
    // `asOf` (#81) picks the default-branch revision that was the page's
    // content then; an explicit `revision` wins over it.
    const named = Boolean(revision);
    const at = revision ? undefined : await this.temporal.resolve(await this.documents.workspaceOf(id), asOf, knownAt);
    if (at) revision = await this.documents.revisionAsOf(id, at);
    // Read off the request rather than via @Headers(): that decorator emits the
    // header as a *required* parameter in openapi.json and so in the web client.
    const accept = req.headers.accept;
    const ifNoneMatch = req.headers['if-none-match'];
    // The representation depends on Accept either way, so both branches say so.
    res.vary('Accept');
    // A key's read is a view (#79); a session's is dropped by the recorder —
    // SSR and prefetch call this too, so the web counts its own on the page.
    const caller = { principal, noTrack: noTrackOf(req.headers) };
    if (this.aiReadable.enabled() && prefersMarkdown(accept)) {
      const result = await this.aiReadable.pageMarkdown(id, {
        revisionId: revision || undefined,
        frontmatter: wantsFrontmatter(frontmatter),
        ifNoneMatch,
      });
      if (result.status === 200) void this.analytics.view(caller, id, revision || null);
      return sendPageMarkdown(res, result);
    }
    const target = await this.documents.contentRevision(id, revision);
    // A named revision's bytes never change; the head moves, so it revalidates.
    if (named) setCachePolicy(res, 'immutable');
    void this.analytics.view(caller, id, target.revision.id);
    if (notModified(req, res, 'content', target.revision.id, at ?? null)) return undefined;
    return withAsOf(await this.documents.readContent(target), at);
  }

  @Get(':id/connectors')
  @Returns('DocumentConnectorResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'External systems this page is linked to (docs/features/19)' })
  async connectors(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentConnectorResponse> {
    return { documentId: id, links: await this.connectorLinks.listForDocument(id) };
  }

  /**
   * Publish this page to the connector it is linked to. Lives here rather than
   * under /v1/connectors because the action belongs to the page: the reader is
   * looking at a document, not administering a connection.
   */
  @Post(':id/push')
  @Returns('PushDocumentResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Publish this page back to its connector (docs/features/19)' })
  async push(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<PushDocumentResponse> {
    const link = await this.connectorLinks.pushTargetFor(id);
    const connector = await this.connectorsService.require(link.connectorId);
    const run = await this.connectorsService.createRun(connector, 'push', 'manual', {
      externalIds: [link.externalId],
      actorId: principal?.userId,
    });
    await this.connectorProducer.enqueue(run.id);
    return { run: toRunInfo(run) };
  }

  @Get(':id/ancestors')
  @Returns('DocumentAncestorsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Ancestor chain (root first) — for breadcrumbs and lazy tree expansion' })
  async ancestors(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentAncestorsResponse> {
    return this.documents.getAncestors(id, await this.permissions.scopeForDocument(principal, id));
  }

  @Get(':id/graph')
  @Returns('DocumentGraphResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Document neighbourhood in the knowledge graph (feature 06); depth = entity hops (1-3)' })
  @ApiQuery({ name: 'depth', required: false })
  @ApiAsOfQuery()
  async graph(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('depth') depth?: string,
    @Query('asOf') asOf?: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<DocumentGraphResponse> {
    const scope = await this.permissions.scopeForDocument(principal, id);
    const at = await this.temporal.resolve(scope.workspaceId, asOf, knownAt);
    return withAsOf(await this.documents.getDocumentGraph(id, depth ? Number(depth) : 1, scope, at), at);
  }

  @Get(':id/revisions')
  @Returns('ListRevisionsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List revisions with DAG parentage (optionally filtered by branch)' })
  @ApiQuery({ name: 'branch', required: false })
  async listRevisions(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('branch') branch?: string,
  ): Promise<ListRevisionsResponse> {
    return this.documents.listRevisions(id, await this.permissions.scopeForDocument(principal, id), branch);
  }

  @Post(':id/branches')
  @Returns('CreateBranchResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Create a branch from a revision (defaults to default-branch head)' })
  createBranch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBranchDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateBranchResponse> {
    return this.documents.createBranch(id, dto, principal.userId);
  }

  @Post(':id/branches/mine')
  @Returns('MyDraftBranchResponse')
  @Access('editor', 'document')
  @ApiOperation({
    summary: "The caller's private working branch for this page (#474), created on first ask",
    description:
      'What the editor edits a published page on. One per person and project (#636): a page not on it yet forks onto ' +
      "the caller's newest live draft at the default head. Spent once a merge request from it is merged or closed: the " +
      'next call starts a fresh one. A page branch nothing was written on follows the default head. `pages` lists the ' +
      'pages the draft has revisions on.',
  })
  myDraftBranch(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<MyDraftBranchResponse> {
    return this.documents.myDraftBranch(id, principal.userId);
  }

  @Get(':id/branches')
  @Returns('ListBranchesResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List branches with head revisions' })
  async listBranches(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ListBranchesResponse> {
    return this.documents.listBranches(id, await this.permissions.scopeForDocument(principal, id));
  }

  @Get(':id/compare')
  @Returns('CompareResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Compare two revisions (direct or merge-base mode, plan.md §8)' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'mode', required: false, enum: ['direct', 'merge-base'] })
  @ApiQuery({ name: 'structural', required: false, description: 'Include path-level structural diff (default true)' })
  @ApiQuery({ name: 'semantic', required: false, description: 'Include graph-projection semantic diff (default false)' })
  compare(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from', ParseUUIDPipe) from: string,
    @Query('to', ParseUUIDPipe) to: string,
    @Query('mode') mode = 'direct',
    @Query('structural') structural?: string,
    @Query('semantic') semantic?: string,
  ): Promise<CompareResponse> {
    if (mode !== 'direct' && mode !== 'merge-base') {
      throw new BadRequestException(t('error.compare.badMode', { mode }));
    }
    return this.compareService.compare(id, from, to, mode as CompareMode, {
      structural: structural !== 'false',
      semantic: semantic === 'true',
    });
  }

  @Post(':id/relations')
  @Returns('ListDocumentRelationsResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Attach explicit relations (graph edges with provenance)' })
  addRelations(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRelationsDto, @CurrentPrincipal() principal: Principal): Promise<ListDocumentRelationsResponse> {
    return this.documents.addRelations(id, dto.relations, principal.userId);
  }

  @Post(':id/relations/curate')
  @Returns('ListDocumentRelationsResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Curate a relation: user-confirmed, confidence 1, protected from re-extraction (plan.md §5)' })
  curateRelation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CurateRelationDto, @CurrentPrincipal() principal: Principal): Promise<ListDocumentRelationsResponse> {
    return this.documents.curateRelation(id, dto.relation, principal.userId);
  }

  @Post(':id/relations/propose')
  @Returns('ProposeRelationsResponse')
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Propose a change to the page’s frontmatter relations as a merge request (never edits the live page)',
  })
  proposeRelations(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProposeRelationsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProposeRelationsResponse> {
    return this.relations.propose(id, dto, principal);
  }

  @Delete(':id/relations')
  @Returns('ListDocumentRelationsResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Delete relation edges by type + targetKey (optionally one extractor class)' })
  @ApiQuery({ name: 'type', required: true })
  @ApiQuery({ name: 'targetKey', required: true })
  @ApiQuery({ name: 'extractor', required: false, enum: ['explicit', 'frontmatter', 'inferred', 'curated'] })
  deleteRelation(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('type') type: string,
    @Query('targetKey') targetKey: string,
    @CurrentPrincipal() principal: Principal,
    @Query('extractor') extractor?: string,
  ): Promise<ListDocumentRelationsResponse> {
    if (!type || !targetKey) throw new BadRequestException(t('error.relations.missingParams'));
    return this.documents.deleteRelation(id, type, targetKey, extractor, principal.userId);
  }

  @Get(':id/relations')
  @Returns('ListDocumentRelationsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List the document’s relation edges with provenance' })
  listRelations(@Param('id', ParseUUIDPipe) id: string): Promise<ListDocumentRelationsResponse> {
    return this.documents.listRelations(id);
  }

  @Post(':id/uploads')
  @Returns('CreateUploadResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Create (or reuse) draft revision + get presigned PUT URL' })
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateUploadDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateUploadResponse> {
    return this.documents.createUpload(id, dto, principal?.userId);
  }

  @Post(':id/revisions')
  @Returns('RevisionInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Create new draft revision on branch head (If-Match: expected head revision id)' })
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'Optimistic concurrency (plan.md §7): expected branch-head revision id; 409 + comparison link when the head advanced',
  })
  createRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRevisionDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('if-match') ifMatch?: string,
  ): Promise<RevisionInfo> {
    const expectedHead = ifMatch?.trim().replace(/^"+|"+$/g, '') || undefined;
    return this.documents.createRevision(id, dto, expectedHead, principal?.userId);
  }

  @Post(':id/revisions/:revisionId/finalize')
  @Returns('FinalizeRevisionResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Finalize an uploaded revision: hash, dedupe, enqueue indexing' })
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
  ): Promise<FinalizeRevisionResponse> {
    return this.documents.finalizeRevision(id, revisionId);
  }

  @Get(':id/facts')
  @Returns('FactsAtResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Facts asserted as of a revision (Phase 5 historical queries, plan.md §11)' })
  @ApiQuery({ name: 'at', required: true, description: 'Revision id to evaluate the fact set at' })
  factsAt(@Param('id', ParseUUIDPipe) id: string, @Query('at', ParseUUIDPipe) at: string): Promise<FactsAtResponse> {
    return this.history.factsAt(id, at);
  }

  @Get(':id/facts/timeline')
  @Returns('FactTimelineResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Fact lifecycle along a branch: introduced/removed revisions (removed-facts audit)' })
  @ApiQuery({ name: 'branch', required: false, description: 'Defaults to the default branch' })
  factTimeline(@Param('id', ParseUUIDPipe) id: string, @Query('branch') branch?: string): Promise<FactTimelineResponse> {
    return this.history.timeline(id, branch);
  }

  // -------------------------------------------------------------------------
  // Feature 15: comments on the page. Writing one is a `viewer` action — a
  // reader who may read a page may annotate it; changing the page still needs
  // `editor`.
  // -------------------------------------------------------------------------

  /* ----------------------------------------- glossary exclusions (feature 14) */

  // Hung off the document, not the term: `@Access(…, 'document')` then resolves
  // the workspace from `:id` for free, and reading is `viewer` because whoever
  // may read a page may see which of its words are not vocabulary.
  @Get(':id/glossary-exclusions')
  @Returns('ListGlossaryExclusionsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Occurrences on this page that are not mentions of a glossary term' })
  listGlossaryExclusions(@Param('id', ParseUUIDPipe) id: string): Promise<ListGlossaryExclusionsResponse> {
    return this.glossary.listExclusions(id);
  }

  @Post(':id/glossary-exclusions')
  @Returns('GlossaryExclusion')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Stop linking one occurrence of a term on this page' })
  createGlossaryExclusion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateGlossaryExclusionDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GlossaryExclusion> {
    return this.glossary.addExclusion(id, dto, principal?.userId);
  }

  @Delete(':id/glossary-exclusions/:exclusionId')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Link this occurrence again' })
  deleteGlossaryExclusion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exclusionId', ParseUUIDPipe) exclusionId: string,
  ) {
    return this.glossary.removeExclusion(id, exclusionId);
  }

  @Get(':id/threads')
  @Returns('ListDocumentThreadsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Comment threads on a document (feature 15)' })
  listThreads(@Param('id', ParseUUIDPipe) id: string): Promise<ListDocumentThreadsResponse> {
    return this.threads.list(id);
  }

  @Post(':id/threads')
  @Returns('CreateDocumentThreadResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Start a comment thread, optionally anchored to a passage' })
  createThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateThreadDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateDocumentThreadResponse> {
    return this.threads.createThread(id, dto, principal?.userId);
  }

  @Post(':id/threads/:threadId/comments')
  @Returns('CreateDocumentThreadResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Reply in a comment thread' })
  replyToThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateDocumentThreadResponse> {
    return this.threads.reply(id, threadId, dto.body, principal?.userId, dto.replyToId);
  }

  @Patch(':id/threads/:threadId/comments/:commentId')
  @Returns('DocumentThreadResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: "Edit a page comment (the comment's own author only)" })
  editThreadComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentThreadResponse> {
    return this.threads.editComment(id, threadId, commentId, dto.body, principal?.userId);
  }

  @Delete(':id/threads/:threadId/comments/:commentId')
  @Returns('DeleteDocumentCommentResponse')
  @Access('viewer', 'document')
  @ApiOperation({
    summary: "Delete a page comment (the comment's own author only); removes the thread if it was the last one",
  })
  deleteThreadComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeleteDocumentCommentResponse> {
    return this.threads.deleteComment(id, threadId, commentId, principal?.userId);
  }

  @Patch(':id/threads/:threadId')
  @Returns('DocumentThreadResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Resolve or reopen a comment thread' })
  resolveThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: ResolveThreadDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentThreadResponse> {
    return this.threads.setResolved(id, threadId, dto.resolved, principal?.userId);
  }
}
