import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type {
  ApiDriftCheckResponse,
  ApiOperationSamplesResponse,
  ApiSettingsResponse,
  ApiSpecDiff,
  ApiSpecDocumentResponse,
  ApiTestSuiteResponse,
  ApiTryResponse,
  GenerateApiTestSuiteResponse,
  ListApiOperationsResponse,
  ListApiSpecsResponse,
  ListTestFixturesResponse,
  SearchApiOperationsResponse,
  TestFixtureResponse,
} from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ApiDriftCheckService } from './api-drift-check.service.js';
import { ApiFixturesService } from './api-fixtures.service.js';
import { ApiSpecDiffService } from './api-spec-diff.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';
import { ApiSettingsService } from './api-settings.service.js';
import { ApiTestSuiteRequestsService } from './api-test-suite-requests.service.js';
import { ApiTryService } from './api-try.service.js';
import {
  ApiSamplesQueryDto,
  ApiSpecDiffQueryDto,
  ApiSpecRevisionQueryDto,
  ApiTestSuiteQueryDto,
  ApiTryRequestDto,
  GenerateApiTestSuiteDto,
  ListApiSpecsQueryDto,
  ListTestFixturesQueryDto,
  SearchApiOperationsQueryDto,
  UpdateApiSettingsDto,
} from './api-specs.dto.js';

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
    private readonly tries: ApiTryService,
    private readonly diffs: ApiSpecDiffService,
    private readonly driftChecks: ApiDriftCheckService,
    private readonly testSuites: ApiTestSuiteRequestsService,
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

  @Get(':id/diff')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'The classified diff between two revisions of a spec: every change by rule, breaking first. Operations ' +
      'match by method and path, so reordering parameters or renaming a path parameter is no change',
  })
  async diff(@Param('id', ParseUUIDPipe) id: string, @Query() query: ApiSpecDiffQueryDto): Promise<ApiSpecDiff> {
    return this.diffs.require(id, query.from, query.to);
  }

  @Get(':id/samples')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      "One operation's code samples (curl, JavaScript, Python, Go): the spec's x-codeSamples where it has them, " +
      'generated elsewhere, with environment-variable placeholders for credentials',
  })
  samples(@Param('id', ParseUUIDPipe) id: string, @Query() query: ApiSamplesQueryDto): Promise<ApiOperationSamplesResponse> {
    return this.reads.samples(id, query);
  }

  @Get(':id/test-suite')
  @Access('viewer', 'document')
  @ApiProduces('application/json', 'text/x-shellscript')
  @ApiOkResponse({ description: 'The suite as JSON; with format, a file to download' })
  @ApiOperation({
    summary:
      "One operation's cached QA test suite (#468), for the operation as it stands at the head. 404 until one is " +
      'generated, and again after an edit to the operation. format=curl|postman answers with the suite as a file',
  })
  async testSuite(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiTestSuiteQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiTestSuiteResponse | string> {
    if (!query.format) return this.testSuites.get(id, query.entityKey);
    const file = await this.testSuites.export(id, query.entityKey, query.format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return file.body;
  }

  // Viewer, not editor: generating writes no page. The capability is the gate,
  // and the tester run checks it again when it executes.
  @Post(':id/test-suite')
  @HttpCode(200)
  @Access('viewer', 'document', { capability: 'api-test-suites.generate' })
  @ApiOperation({
    summary:
      "Generate one operation's QA test suite (#468): the cached suite when there is one and regenerate is not " +
      'set, otherwise a queued tester run (one per operation and config in flight). Needs the ' +
      'api-test-suites.generate capability',
  })
  generateTestSuite(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateApiTestSuiteDto,
  ): Promise<GenerateApiTestSuiteResponse> {
    return this.testSuites.generate(principal, id, dto.entityKey, dto.regenerate === true);
  }

  @Post(':id/try')
  @HttpCode(200)
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Send one request to a server this revision names, for an operation it defines — the try-it proxy. ' +
      "403 while the workspace's mode is off; redirects are returned, not followed; Set-Cookie is dropped",
  })
  try(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApiTryRequestDto,
  ): Promise<ApiTryResponse> {
    return this.tries.send(principal, id, dto);
  }

  @Post(':id/drift-check')
  @HttpCode(202)
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Compare an OpenAPI spec with the routes its repository declares (NestJS, Express/Fastify, FastAPI, Go), on ' +
      'the default branch. Queues a sentinel run whose findings are the disagreements; a check already waiting is ' +
      'returned. 400 when no connected repository syncs the spec',
  })
  driftCheck(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<ApiDriftCheckResponse> {
    return this.driftChecks.start(principal, id);
  }
}

/** A workspace's API reference settings (#78): the try-it proxy mode, asked for beside applied. */
@ApiTags('api-specs')
@Controller('v1/workspaces')
export class ApiSettingsController {
  constructor(private readonly settings: ApiSettingsService) {}

  // A viewer reads it: the console has to know whether the proxy is there.
  @Get(':id/api-settings')
  @Access('viewer', 'workspace')
  @ApiOperation({ summary: "The workspace's API reference settings: what is asked for, the deployment ceiling, what applies" })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiSettingsResponse> {
    return this.settings.get(id);
  }

  @Patch(':id/api-settings')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Override the API reference settings; null on a key inherits the deployment value' })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApiSettingsDto,
  ): Promise<ApiSettingsResponse> {
    return this.settings.update(id, dto, principal?.userId);
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
    return this.reads.search(scope, {
      q: query.q,
      documentId: query.documentId,
      entityKeys: query.entityKey ? [query.entityKey] : undefined,
      limit: query.limit,
    });
  }
}

/**
 * QA test fixtures (#483). A fixture is a document, so its writes are the
 * document routes (`kind: test-fixture`); these are the reads it adds — the
 * library and one fixture checked against today's specs.
 */
@ApiTags('api-specs')
@Controller('v1/test-fixtures')
export class TestFixturesController {
  constructor(
    private readonly fixtures: ApiFixturesService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({
    summary:
      'Test fixtures the caller may open, each with the operations its head calls and which of those no spec head ' +
      'defines any more. Narrow by project, by one operation, or by the operations of one spec',
  })
  async list(@CurrentPrincipal() principal: Principal, @Query() query: ListTestFixturesQueryDto): Promise<ListTestFixturesResponse> {
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return this.fixtures.list(scope, query);
  }

  @Get(':id')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'One revision of a test fixture (the head unless revisionId is given): its parsed steps, the operation each ' +
      'call resolves to, the inputs and secrets a run must supply, and its issues against the specs as they stand now',
  })
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiSpecRevisionQueryDto,
  ): Promise<TestFixtureResponse> {
    return this.fixtures.get(await this.permissions.scopeForDocument(principal, id), id, query.revisionId);
  }
}
