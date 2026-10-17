import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ApiSpecDocumentResponse,
  ListApiOperationsResponse,
  ListApiSpecsResponse,
  SearchApiOperationsResponse,
} from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';
import { ApiSpecRevisionQueryDto, ListApiSpecsQueryDto, SearchApiOperationsQueryDto } from './api-specs.dto.js';

/**
 * API spec documents (#78, phase 2). A spec is a document, so its writes are
 * the document routes; these are the reads a spec adds — the parsed spec and
 * its operations. The list is workspace-level and filters by scope, so a guest
 * may call it.
 */
@ApiTags('api-specs')
@Controller('v1/api-specs')
export class ApiSpecsController {
  constructor(
    private readonly reads: ApiSpecReadService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'Spec documents in the workspace (or one project) and how many operations each head defines' })
  async list(@CurrentPrincipal() principal: Principal, @Query() query: ListApiSpecsQueryDto): Promise<ListApiSpecsResponse> {
    return this.reads.list(await this.permissions.scopeFor(principal, query.workspaceId), query.projectId);
  }

  @Get(':id')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'One revision of a spec, parsed: OpenAPI upgraded to 3.1, AsyncAPI as written, internal $refs kept. ' +
      'The default-branch head unless revisionId is given; 400 for a page or a draft revision',
  })
  spec(@Param('id', ParseUUIDPipe) id: string, @Query() query: ApiSpecRevisionQueryDto): Promise<ApiSpecDocumentResponse> {
    return this.reads.spec(id, query.revisionId);
  }

  @Get(':id/operations')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'The operations and channels of one revision of a spec, in spec order. Empty while that revision is still ' +
      'indexing — revisionStatus says which',
  })
  operations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiSpecRevisionQueryDto,
  ): Promise<ListApiOperationsResponse> {
    return this.reads.operations(id, query.revisionId);
  }
}

/** The operation picker (#78): operations across every spec the caller may open, at each spec's head. */
@ApiTags('api-specs')
@Controller('v1/api-operations')
export class ApiOperationsController {
  constructor(
    private readonly reads: ApiSpecReadService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'Search API operations by method + path, summary, operationId or entity key' })
  async search(
    @CurrentPrincipal() principal: Principal,
    @Query() query: SearchApiOperationsQueryDto,
  ): Promise<SearchApiOperationsResponse> {
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return this.reads.search(scope, { q: query.q, documentId: query.documentId, limit: query.limit });
  }
}
