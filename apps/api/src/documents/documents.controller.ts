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
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CompareMode, DocumentConnectorResponse, PushDocumentResponse } from '@knowledge/contracts';
import { ConnectorLinksService } from '../connectors/connector-links.service.js';
import { ConnectorProducer } from '../connectors/connector.producer.js';
import { ConnectorsService, toRunInfo } from '../connectors/connectors.service.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { DocumentsService } from './documents.service.js';
import { HistoryService } from './history.service.js';
import { DocumentThreadsService } from './document-threads.service.js';
import { CompareService } from './compare.service.js';
import {
  AddRelationsDto,
  CreateBranchDto,
  CreateDocumentDto,
  CreateRevisionDto,
  CreateUploadDto,
  CurateRelationDto,
  UpdateDocumentDto,
} from './dto/documents.dto.js';
import { CreateCommentDto, CreateThreadDto, ResolveThreadDto } from './dto/merge-requests.dto.js';
import { t } from '../i18n/t.js';

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
    private readonly connectorLinks: ConnectorLinksService,
    private readonly connectorsService: ConnectorsService,
    private readonly connectorProducer: ConnectorProducer,
    private readonly compareService: CompareService,
    private readonly history: HistoryService,
    private readonly threads: DocumentThreadsService,
  ) {}

  @Post()
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Create document (optionally inline content, auto-finalizes)' })
  create(@Body() dto: CreateDocumentDto, @CurrentPrincipal() principal: Principal) {
    return this.documents.createDocument(dto, principal?.userId);
  }

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List documents in workspace, filtered by the search facets' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  @ApiQuery({ name: 'category', required: false, description: 'Restrict to one category' })
  @ApiQuery({ name: 'projectIds', required: false, description: 'Comma-separated project ids' })
  @ApiQuery({ name: 'categories', required: false, description: 'Comma-separated categories' })
  @ApiQuery({
    name: 'tags',
    required: false,
    description: 'Comma-separated frontmatter tags; bare name or `tag:` entity key',
  })
  list(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('category') category?: string,
    @Query('projectId') projectId?: string,
    @Query('categories') categories?: string,
    @Query('projectIds') projectIds?: string,
    @Query('tags') tags?: string,
  ) {
    // The singular params predate the facets and still work; each is folded
    // into its plural so callers never have to know which one won.
    return this.documents.listDocuments(workspaceId, limit ? Number(limit) : 20, cursor, {
      categories: csv(categories, category),
      projectIds: csv(projectIds, projectId),
      tags: csv(tags),
    });
  }

  @Get('tree')
  @Access('viewer', 'query')
  @ApiOperation({
    summary: 'Document hierarchy (feature 08). Omit depth for the whole tree; pass depth=1 to walk it a level at a time',
  })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  @ApiQuery({ name: 'parentId', required: false, description: 'Children of this node; omit for the top level' })
  @ApiQuery({ name: 'depth', required: false, description: 'Levels to load below parentId; omit to load all of them' })
  tree(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('projectId') projectId?: string,
    @Query('parentId') parentId?: string,
    @Query('depth') depth?: string,
  ) {
    return this.documents.getTree(workspaceId, projectId || undefined, {
      parentId: parentId || null,
      ...(depth ? { depth: Number(depth) } : {}),
    });
  }

  // Declared before @Get(':id') — 'graph' would otherwise parse as a document id.
  @Get('graph')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Whole-workspace relation graph for the pages landing; scoped to one project when projectId is given' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict the graph to one project' })
  workspaceGraph(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.documents.getWorkspaceGraph(workspaceId, projectId || undefined);
  }

  @Get(':id')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Get document + its head (or given) revision + chunk summaries' })
  get(@Param('id', ParseUUIDPipe) id: string, @Query('revision') revision?: string) {
    return this.documents.getDocument(id, revision);
  }

  @Patch(':id')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Update title / category / parent (features 07 + 08); parentId: null re-roots' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.documents.updateDocument(id, dto, principal?.userId);
  }

  @Get(':id/content')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Full raw content of a revision (feature 01; head of the default branch by default)' })
  @ApiQuery({ name: 'revision', required: false })
  content(@Param('id', ParseUUIDPipe) id: string, @Query('revision') revision?: string) {
    return this.documents.getContent(id, revision);
  }

  @Get(':id/connectors')
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
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Ancestor chain (root first) — for breadcrumbs and lazy tree expansion' })
  ancestors(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getAncestors(id);
  }

  @Get(':id/graph')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Document neighbourhood in the knowledge graph (feature 06); depth = entity hops (1-3)' })
  @ApiQuery({ name: 'depth', required: false })
  graph(@Param('id', ParseUUIDPipe) id: string, @Query('depth') depth?: string) {
    return this.documents.getDocumentGraph(id, depth ? Number(depth) : 1);
  }

  @Get(':id/revisions')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List revisions with DAG parentage (optionally filtered by branch)' })
  @ApiQuery({ name: 'branch', required: false })
  listRevisions(@Param('id', ParseUUIDPipe) id: string, @Query('branch') branch?: string) {
    return this.documents.listRevisions(id, branch);
  }

  @Post(':id/branches')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Create a branch from a revision (defaults to default-branch head)' })
  createBranch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateBranchDto) {
    return this.documents.createBranch(id, dto);
  }

  @Get(':id/branches')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List branches with head revisions' })
  listBranches(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listBranches(id);
  }

  @Get(':id/compare')
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
  ) {
    if (mode !== 'direct' && mode !== 'merge-base') {
      throw new BadRequestException(t('error.compare.badMode', { mode }));
    }
    return this.compareService.compare(id, from, to, mode as CompareMode, {
      structural: structural !== 'false',
      semantic: semantic === 'true',
    });
  }

  @Post(':id/relations')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Attach explicit relations (graph edges with provenance)' })
  addRelations(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRelationsDto) {
    return this.documents.addRelations(id, dto.relations);
  }

  @Post(':id/relations/curate')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Curate a relation: user-confirmed, confidence 1, protected from re-extraction (plan.md §5)' })
  curateRelation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CurateRelationDto) {
    return this.documents.curateRelation(id, dto.relation);
  }

  @Delete(':id/relations')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Delete relation edges by type + targetKey (optionally one extractor class)' })
  @ApiQuery({ name: 'type', required: true })
  @ApiQuery({ name: 'targetKey', required: true })
  @ApiQuery({ name: 'extractor', required: false, enum: ['explicit', 'frontmatter', 'inferred', 'curated'] })
  deleteRelation(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('type') type: string,
    @Query('targetKey') targetKey: string,
    @Query('extractor') extractor?: string,
  ) {
    if (!type || !targetKey) throw new BadRequestException(t('error.relations.missingParams'));
    return this.documents.deleteRelation(id, type, targetKey, extractor);
  }

  @Get(':id/relations')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List the document’s relation edges with provenance' })
  listRelations(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listRelations(id);
  }

  @Post(':id/uploads')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Create (or reuse) draft revision + get presigned PUT URL' })
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateUploadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.documents.createUpload(id, dto, principal?.userId);
  }

  @Post(':id/revisions')
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
  ) {
    const expectedHead = ifMatch?.trim().replace(/^"+|"+$/g, '') || undefined;
    return this.documents.createRevision(id, dto, expectedHead, principal?.userId);
  }

  @Post(':id/revisions/:revisionId/finalize')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Finalize an uploaded revision: hash, dedupe, enqueue indexing' })
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
  ) {
    return this.documents.finalizeRevision(id, revisionId);
  }

  @Get(':id/facts')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Facts asserted as of a revision (Phase 5 historical queries, plan.md §11)' })
  @ApiQuery({ name: 'at', required: true, description: 'Revision id to evaluate the fact set at' })
  factsAt(@Param('id', ParseUUIDPipe) id: string, @Query('at', ParseUUIDPipe) at: string) {
    return this.history.factsAt(id, at);
  }

  @Get(':id/facts/timeline')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Fact lifecycle along a branch: introduced/removed revisions (removed-facts audit)' })
  @ApiQuery({ name: 'branch', required: false, description: 'Defaults to the default branch' })
  factTimeline(@Param('id', ParseUUIDPipe) id: string, @Query('branch') branch?: string) {
    return this.history.timeline(id, branch);
  }

  // -------------------------------------------------------------------------
  // Feature 15: comments on the page. Writing one is a `viewer` action — a
  // reader who may read a page may annotate it; changing the page still needs
  // `editor`.
  // -------------------------------------------------------------------------

  @Get(':id/threads')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Comment threads on a document (feature 15)' })
  listThreads(@Param('id', ParseUUIDPipe) id: string) {
    return this.threads.list(id);
  }

  @Post(':id/threads')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Start a comment thread, optionally anchored to a passage' })
  createThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateThreadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.createThread(id, dto, principal?.userId);
  }

  @Post(':id/threads/:threadId/comments')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Reply in a comment thread' })
  replyToThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.reply(id, threadId, dto.body, principal?.userId, dto.replyToId);
  }

  @Patch(':id/threads/:threadId/comments/:commentId')
  @Access('viewer', 'document')
  @ApiOperation({ summary: "Edit a page comment (the comment's own author only)" })
  editThreadComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.editComment(id, threadId, commentId, dto.body, principal?.userId);
  }

  @Delete(':id/threads/:threadId/comments/:commentId')
  @Access('viewer', 'document')
  @ApiOperation({
    summary: "Delete a page comment (the comment's own author only); removes the thread if it was the last one",
  })
  deleteThreadComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.deleteComment(id, threadId, commentId, principal?.userId);
  }

  @Patch(':id/threads/:threadId')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Resolve or reopen a comment thread' })
  resolveThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: ResolveThreadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.setResolved(id, threadId, dto.resolved, principal?.userId);
  }
}
