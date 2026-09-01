import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CompareMode } from '@knowledge/contracts';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import {
  AddRelationsDto,
  CreateBranchDto,
  CreateDocumentDto,
  CreateRevisionDto,
  CreateUploadDto,
  CurateRelationDto,
} from './dto/documents.dto.js';

@ApiTags('documents')
@Controller('v1/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly compareService: CompareService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create document (optionally inline content, auto-finalizes)' })
  create(@Body() dto: CreateDocumentDto) {
    return this.documents.createDocument(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List documents in workspace' })
  list(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.documents.listDocuments(workspaceId, limit ? Number(limit) : 20, cursor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get document + its head (or given) revision + chunk summaries' })
  get(@Param('id', ParseUUIDPipe) id: string, @Query('revision') revision?: string) {
    return this.documents.getDocument(id, revision);
  }

  @Get(':id/revisions')
  @ApiOperation({ summary: 'List revisions with DAG parentage (optionally filtered by branch)' })
  @ApiQuery({ name: 'branch', required: false })
  listRevisions(@Param('id', ParseUUIDPipe) id: string, @Query('branch') branch?: string) {
    return this.documents.listRevisions(id, branch);
  }

  @Post(':id/branches')
  @ApiOperation({ summary: 'Create a branch from a revision (defaults to default-branch head)' })
  createBranch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateBranchDto) {
    return this.documents.createBranch(id, dto);
  }

  @Get(':id/branches')
  @ApiOperation({ summary: 'List branches with head revisions' })
  listBranches(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listBranches(id);
  }

  @Get(':id/compare')
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
  @ApiOperation({ summary: 'Attach explicit relations (graph edges with provenance)' })
  addRelations(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRelationsDto) {
    return this.documents.addRelations(id, dto.relations);
  }

  @Post(':id/relations/curate')
  @ApiOperation({ summary: 'Curate a relation: user-confirmed, confidence 1, protected from re-extraction (plan.md §5)' })
  curateRelation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CurateRelationDto) {
    return this.documents.curateRelation(id, dto.relation);
  }

  @Delete(':id/relations')
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
  @ApiOperation({ summary: 'List the document’s relation edges with provenance' })
  listRelations(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listRelations(id);
  }

  @Post(':id/uploads')
  @ApiOperation({ summary: 'Create (or reuse) draft revision + get presigned PUT URL' })
  upload(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateUploadDto) {
    return this.documents.createUpload(id, dto);
  }

  @Post(':id/revisions')
  @ApiOperation({ summary: 'Create new draft revision on branch head (If-Match: expected head revision id)' })
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'Optimistic concurrency (plan.md §7): expected branch-head revision id; 409 + comparison link when the head advanced',
  })
  createRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRevisionDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedHead = ifMatch?.trim().replace(/^"+|"+$/g, '') || undefined;
    return this.documents.createRevision(id, dto, expectedHead);
  }

  @Post(':id/revisions/:revisionId/finalize')
  @ApiOperation({ summary: 'Finalize an uploaded revision: hash, dedupe, enqueue indexing' })
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
  ) {
    return this.documents.finalizeRevision(id, revisionId);
  }
}
