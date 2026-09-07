import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CompareMode } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { DocumentsService } from './documents.service.js';
import { HistoryService } from './history.service.js';
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

@ApiTags('documents')
@Controller('v1/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly compareService: CompareService,
    private readonly history: HistoryService,
  ) {}

  @Post()
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Create document (optionally inline content, auto-finalizes)' })
  create(@Body() dto: CreateDocumentDto, @CurrentPrincipal() principal: Principal) {
    return this.documents.createDocument(dto, principal?.userId);
  }

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List documents in workspace' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  list(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('category') category?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.documents.listDocuments(
      workspaceId,
      limit ? Number(limit) : 20,
      cursor,
      category || undefined,
      projectId || undefined,
    );
  }

  @Get('tree')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Document tree (feature 08 nesting); scoped to one project when projectId is given' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict the tree to one project' })
  tree(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.documents.getTree(workspaceId, projectId || undefined);
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
      throw new BadRequestException(`mode must be "direct" or "merge-base", got "${mode}"`);
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
    if (!type || !targetKey) throw new BadRequestException('type and targetKey query params are required');
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
}
