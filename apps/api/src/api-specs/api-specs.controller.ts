import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type {
  ApiDriftCheckResponse,
  ApiOperationSamplesResponse,
  ApiSettingsResponse,
  ApiSpecDiff,
  ApiSpecDocumentResponse,
  ApiTestBindingsResponse,
  ApiTestEnvironment,
  ApiTestRunDetail,
  ApiTestRunSummary,
  ApiTestFixtureCandidatesResponse,
  ApiTestSuiteResponse,
  ApiTryResponse,
  GenerateApiTestSuiteResponse,
  ListApiOperationsResponse,
  ListApiSpecsResponse,
  ListApiTestEnvironmentsResponse,
  ListApiTestRunsResponse,
  ListTestFixturesResponse,
  QaOverviewResponse,
  RankApiTestFixturesResponse,
  SearchApiOperationsResponse,
  TestFixtureResponse,
  TestRunPlan,
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
import { ApiTestEnvironmentsService } from './api-test-environments.service.js';
import { ApiTestRunsService } from './api-test-runs.service.js';
import { ApiTestSuiteRequestsService } from './api-test-suite-requests.service.js';
import { ApiTryService } from './api-try.service.js';
import {
  ApiSamplesQueryDto,
  ApiSpecDiffQueryDto,
  ApiSpecRevisionQueryDto,
  ApiTestOperationDto,
  ApiTestSuiteQueryDto,
  ApiTryRequestDto,
  GenerateApiTestSuiteDto,
  ListApiSpecsQueryDto,
  ListTestFixturesQueryDto,
  QaOverviewQueryDto,
  RunApiTestSuiteDto,
  SaveApiTestEnvironmentDto,
  SearchApiOperationsQueryDto,
  SetApiTestBindingsDto,
  UpdateApiSettingsDto,
} from './api-specs.dto.js';
import { Returns } from '../common/returns.decorator.js';

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
    private readonly runs: ApiTestRunsService,
  ) {}

  @Get()
  @Returns('ListApiSpecsResponse')
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'Spec documents in the workspace (or one project) and how many operations each head defines' })
  async list(@CurrentPrincipal() principal: Principal, @Query() query: ListApiSpecsQueryDto): Promise<ListApiSpecsResponse> {
    return this.reads.list(await this.permissions.scopeFor(principal, query.workspaceId), query.projectId);
  }

  @Get(':id')
  @Returns('ApiSpecDocumentResponse')
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
  @Returns('ListApiOperationsResponse')
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
  @Returns('ApiSpecDiff')
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
  @Returns('ApiOperationSamplesResponse')
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
      'generated, and again after an edit to the operation or its bound fixtures. format=curl|postman answers with ' +
      'the suite as a file — a bash script or a Postman collection — with the bound fixtures as setup and teardown',
  })
  async testSuite(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiTestSuiteQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiTestSuiteResponse | string> {
    if (!query.format) return this.testSuites.get(id, query.entityKey);
    const scope = await this.permissions.scopeForDocument(principal, id);
    const file = await this.testSuites.export(scope, id, query.entityKey, query.format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return file.body;
  }

  // Viewer, not editor: generating writes no page. The capability is the gate,
  // and the tester run checks it again when it executes.
  @Post(':id/test-suite')
  @Returns('GenerateApiTestSuiteResponse')
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

  @Get(':id/test-bindings')
  @Returns('ApiTestBindingsResponse')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      "The QA fixtures bound to one operation's suite (#483): suite-level setup, and per-case setup by case id. A " +
      'fixture the caller cannot open is listed without its title',
  })
  async testBindings(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiTestOperationDto,
  ): Promise<ApiTestBindingsResponse> {
    return this.testSuites.bindings(await this.permissions.scopeForDocument(principal, id), id, query.entityKey);
  }

  // Viewer + capability, like Generate: binding writes no page.
  @Put(':id/test-bindings')
  @Returns('ApiTestBindingsResponse')
  @Access('viewer', 'document', { capability: 'api-test-suites.generate' })
  @ApiOperation({
    summary:
      "Replace the fixtures bound to one operation's suite (#483), in run order. Every fixture must be a test-fixture " +
      'the caller can open; every case id one the suite lists. Changes the suite cache key. Needs the ' +
      'api-test-suites.generate capability',
  })
  async setTestBindings(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetApiTestBindingsDto,
  ): Promise<ApiTestBindingsResponse> {
    const scope = await this.permissions.scopeForDocument(principal, id);
    const list = dto.bindings.map((b) => ({ caseId: b.caseId ?? null, fixtureId: b.fixtureId }));
    return this.testSuites.setBindings(principal, scope, id, dto.entityKey, list);
  }

  @Get(':id/test-fixture-candidates')
  @Returns('ApiTestFixtureCandidatesResponse')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'Fixtures that could set up one operation (#483): operations of the same spec producing a value it needs ' +
      "(response links, then path parameters) and the fixtures calling them, in spec order or the tester's ranking. " +
      'Nothing is bound',
  })
  async testFixtureCandidates(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiTestOperationDto,
  ): Promise<ApiTestFixtureCandidatesResponse> {
    return this.testSuites.candidates(await this.permissions.scopeForDocument(principal, id), id, query.entityKey);
  }

  @Post(':id/test-fixture-candidates/rank')
  @Returns('RankApiTestFixturesResponse')
  @HttpCode(200)
  @Access('viewer', 'document', { capability: 'api-test-suites.generate' })
  @ApiOperation({
    summary:
      "Ask the tester to rank and explain one operation's fixture candidates (#483). One run per candidate set: a set " +
      'already ranked or being ranked returns that run. Needs the api-test-suites.generate capability',
  })
  async rankTestFixtures(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApiTestOperationDto,
  ): Promise<RankApiTestFixturesResponse> {
    return this.testSuites.rank(principal, await this.permissions.scopeForDocument(principal, id), id, dto.entityKey);
  }

  @Post(':id/try')
  @Returns('ApiTryResponse')
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

  @Get(':id/test-run-plan')
  @Returns('TestRunPlan')
  @Access('viewer', 'document', { capability: 'api-test-suites.run' })
  @ApiOperation({
    summary:
      "One operation's cached QA suite as a run plan (#483): setup, the cases (negative first, each with its own " +
      'setup and teardown), then teardown, every request with {{placeholders}} for captures, inputs and secrets, ' +
      'and the spec revision each call is proxied through. Holds no value. Needs the api-test-suites.run capability',
  })
  async testRunPlan(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ApiTestOperationDto,
  ): Promise<TestRunPlan> {
    return this.testSuites.plan(await this.permissions.scopeForDocument(principal, id), id, query.entityKey);
  }

  // The runner's twin of /try (#483): the same proxy, mode, rate limit and
  // target check, gated by the capability instead of editor, which @Access
  // cannot express as role-or-capability. `:id` is the spec defining the
  // step's operation, so a step in another spec is checked against that one.
  @Post(':id/test-run/send')
  @Returns('ApiTryResponse')
  @HttpCode(200)
  @Access('viewer', 'document', { capability: 'api-test-suites.run' })
  @ApiOperation({
    summary:
      'Send one step of a QA suite run through the try-it proxy: a request to a server this revision names, for ' +
      "an operation it defines. 403 while the workspace's proxy mode is off. Shares try-it's rate limit. Needs the " +
      'api-test-suites.run capability',
  })
  sendTestRunStep(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApiTryRequestDto,
  ): Promise<ApiTryResponse> {
    return this.tries.send(principal, id, dto);
  }

  // The QA server runner (#483, phase 5). Starting a run is the runner's
  // capability on top of viewer, like the browser runner's proxied step; the
  // records are readable by every viewer of the spec.
  @Post(':id/test-runs')
  @Returns('ApiTestRunSummary')
  @HttpCode(202)
  @Access('viewer', 'document', { capability: 'api-test-suites.run' })
  @ApiOperation({
    summary:
      "Run one operation's cached QA suite on the server, against a test environment: queued, then run by the " +
      "worker through the try-it proxy's rules. 403 unless the server runner is on for the workspace. Needs the " +
      'api-test-suites.run capability',
  })
  async startTestRun(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunApiTestSuiteDto,
  ): Promise<ApiTestRunSummary> {
    const scope = await this.permissions.scopeForDocument(principal, id);
    return this.testSuites.runOnServer(principal, scope, id, dto.entityKey, { id: dto.environmentId });
  }

  @Get(':id/test-runs')
  @Returns('ListApiTestRunsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: "One operation's server runs, newest first (the last 20 are kept)" })
  async testRuns(@Param('id', ParseUUIDPipe) id: string, @Query() query: ApiTestOperationDto): Promise<ListApiTestRunsResponse> {
    return { runs: await this.runs.list(id, query.entityKey) };
  }

  @Get(':id/test-runs/:runId')
  @Returns('ApiTestRunDetail')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'One server run: the plan it walked and each step and case result. Captures named like secrets are never stored' })
  testRun(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string): Promise<ApiTestRunDetail> {
    return this.runs.get(id, runId);
  }

  @Post(':id/drift-check')
  @Returns('ApiDriftCheckResponse')
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
  constructor(
    private readonly settings: ApiSettingsService,
    private readonly environments: ApiTestEnvironmentsService,
  ) {}

  // Test environments for the QA server runner (#483, phase 5). Editors manage
  // them; a viewer sees names, servers and inputs. Secrets are write-only.
  @Get(':id/test-environments')
  @Returns('ListApiTestEnvironmentsResponse')
  @Access('viewer', 'workspace')
  @ApiOperation({ summary: "The workspace's QA test environments: server, inputs, and the names of the secrets set (never a value)" })
  async listEnvironments(@Param('id', ParseUUIDPipe) id: string): Promise<ListApiTestEnvironmentsResponse> {
    return { environments: await this.environments.list(id) };
  }

  @Post(':id/test-environments')
  @Returns('ApiTestEnvironment')
  @Access('editor', 'workspace')
  @ApiOperation({ summary: 'Create a QA test environment. Secrets are encrypted at rest and never returned' })
  createEnvironment(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveApiTestEnvironmentDto,
  ): Promise<ApiTestEnvironment> {
    return this.environments.create(id, dto, principal.userId);
  }

  @Patch(':id/test-environments/:environmentId')
  @Returns('ApiTestEnvironment')
  @Access('editor', 'workspace')
  @ApiOperation({ summary: 'Change a QA test environment. inputs replaces the set; a secret set to null is removed, one left out is kept' })
  updateEnvironment(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Body() dto: SaveApiTestEnvironmentDto,
  ): Promise<ApiTestEnvironment> {
    return this.environments.update(id, environmentId, dto, principal.userId);
  }

  @Delete(':id/test-environments/:environmentId')
  @HttpCode(204)
  @Access('editor', 'workspace')
  @ApiOperation({ summary: 'Delete a QA test environment; its past runs keep their results' })
  async deleteEnvironment(@Param('id', ParseUUIDPipe) id: string, @Param('environmentId', ParseUUIDPipe) environmentId: string): Promise<void> {
    await this.environments.remove(id, environmentId);
  }

  // A viewer reads it: the console has to know whether the proxy is there.
  @Get(':id/api-settings')
  @Returns('ApiSettingsResponse')
  @Access('viewer', 'workspace')
  @ApiOperation({ summary: "The workspace's API reference settings: what is asked for, the deployment ceiling, what applies" })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiSettingsResponse> {
    return this.settings.get(id);
  }

  @Patch(':id/api-settings')
  @Returns('ApiSettingsResponse')
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
  @Returns('SearchApiOperationsResponse')
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
  @Returns('ListTestFixturesResponse')
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
  @Returns('TestFixtureResponse')
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

/** The QA view (#483, phase 4): workspace-level and scope-filtered, so a guest may call it. */
@ApiTags('api-specs')
@Controller('v1/qa')
export class QaController {
  constructor(
    private readonly testSuites: ApiTestSuiteRequestsService,
    private readonly permissions: PermissionService,
  ) {}

  @Get('overview')
  @Returns('QaOverviewResponse')
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({
    summary:
      'Every HTTP operation of the OpenAPI specs the caller may open, worst first: whether its QA suite is ' +
      'generated and current, its setup prerequisites and bindings, bound fixtures needing review, and how many ' +
      'fixtures call it',
  })
  async overview(@CurrentPrincipal() principal: Principal, @Query() query: QaOverviewQueryDto): Promise<QaOverviewResponse> {
    return this.testSuites.overview(await this.permissions.scopeFor(principal, query.workspaceId), query);
  }
}
