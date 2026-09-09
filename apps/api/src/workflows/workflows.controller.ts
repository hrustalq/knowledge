import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type {
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  ValidateWorkflowResponse,
  WorkflowDefinitionInfo,
  WorkflowNodeEventResponse,
  WorkflowRunInfo,
  WorkflowRunNodeInfo,
  WorkflowRunResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowMaterializerService } from './workflow-materializer.service.js';
import {
  CreateWorkflowDto,
  ListWorkflowRunsQueryDto,
  ListWorkflowsQueryDto,
  StartWorkflowRunDto,
  UpdateWorkflowDto,
  UpdateWorkflowNodeDto,
  ValidateWorkflowDto,
  WorkflowNodeEventDto,
  WorkflowRunEventDto,
} from './workflows.dto.js';

/**
 * Dynamic document workflows (docs/features/17).
 *
 * Definitions are `admin` to write — a workflow decides what the assistant
 * writes into a workspace, which is the same bar as the AI settings that decide
 * how. Runs are `editor`, including approval: approving a draft creates a page,
 * so it needs exactly the authority editing a page needs.
 *
 * Every `:id` route resolves its workspace in PostgreSQL from the id itself
 * (`workflow-definition` / `workflow-run` sources), so a run id belonging to
 * another tenant is a 403 before the handler runs.
 */
@ApiTags('workflows')
@Controller('v1/workflows')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly materializer: WorkflowMaterializerService,
  ) {}

  // --------------------------------------------------------------- runs
  // Declared before `:id` — Nest matches in declaration order, so the literal
  // `runs` segment has to precede the parameterised one (the same reason
  // `GET /v1/documents/tree` precedes `GET /v1/documents/:id`).

  @Get('runs')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'projectId', required: false })
  @ApiQuery({ name: 'definitionId', required: false })
  @ApiQuery({ name: 'documentId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({
    summary:
      'Workflow runs, newest first. `counts` covers every status under the same ' +
      'filters, so status badges do not move as you switch between them.',
  })
  listRuns(@Query() query: ListWorkflowRunsQueryDto): Promise<ListWorkflowRunsResponse> {
    return this.workflows.listRuns(query);
  }

  @Post('runs')
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Start a run against a page (409 when one is already in flight for that page)',
  })
  startRun(
    @Body() dto: StartWorkflowRunDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkflowRunInfo> {
    return this.workflows.startRun(dto, principal?.userId);
  }

  @Get('runs/:id')
  @Access('viewer', 'workflow-run')
  @ApiOperation({ summary: 'A run with its frozen graph and its node tree — the intermediate results' })
  getRun(@Param('id', ParseUUIDPipe) id: string): Promise<WorkflowRunResponse> {
    return this.workflows.getRun(id);
  }

  @Post('runs/:id/events')
  @Access('editor', 'workflow-run')
  @ApiOperation({ summary: 'Pause, resume or cancel a run (409 when the machine refuses the transition)' })
  runEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WorkflowRunEventDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkflowRunInfo> {
    return this.workflows.sendRunEvent(id, dto.type, principal?.userId);
  }

  @Patch('runs/:id/nodes/:nodeId')
  @Access('editor', 'workflow-run')
  @ApiOperation({ summary: 'Edit a draft before approving it' })
  updateNode(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: UpdateWorkflowNodeDto,
  ): Promise<WorkflowRunNodeInfo> {
    return this.workflows.updateNodeDraft(id, nodeId, dto.draft);
  }

  @Post('runs/:id/nodes/:nodeId/events')
  @Access('editor', 'workflow-run')
  @ApiOperation({
    summary:
      'The review gate: APPROVE (materialises the draft and opens the next steps), ' +
      'REJECT, SKIP or RETRY. APPROVE may carry a last-moment edit.',
  })
  nodeEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: WorkflowNodeEventDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkflowNodeEventResponse> {
    return this.workflows.sendNodeEvent(id, nodeId, dto.type, dto.draft, principal?.userId, (node, run, step) =>
      this.materializer.materialize(node, run, step, principal?.userId),
    );
  }

  // --------------------------------------------------------- definitions

  @Get()
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'projectId', required: false, description: 'Adds this project’s definitions to the workspace-wide ones' })
  @ApiOperation({ summary: 'Workflow definitions available in a workspace or project' })
  list(@Query() query: ListWorkflowsQueryDto): Promise<ListWorkflowsResponse> {
    return this.workflows.list(query);
  }

  @Post()
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Create a workflow (400 with per-step issues when the graph is invalid)' })
  create(
    @Body() dto: CreateWorkflowDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkflowDefinitionInfo> {
    return this.workflows.create(dto, principal?.userId);
  }

  @Get(':id')
  @Access('viewer', 'workflow-definition')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<WorkflowDefinitionInfo> {
    return this.workflows.get(id);
  }

  @Patch(':id')
  @Access('admin', 'workflow-definition')
  @ApiOperation({ summary: 'Update a workflow; a graph change bumps its version' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkflowDefinitionInfo> {
    return this.workflows.update(id, dto, principal?.userId);
  }

  @Delete(':id')
  @Access('admin', 'workflow-definition')
  @ApiOperation({ summary: 'Delete a workflow (409 while runs of it are still in flight)' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ ok: true }> {
    await this.workflows.remove(id, principal?.userId);
    return { ok: true };
  }

  @Post(':id/validate')
  @Access('viewer', 'workflow-definition')
  @ApiOperation({
    summary:
      'Compile a graph and report its issues without saving — the editor’s live check. ' +
      'Omit `graph` to validate the stored one.',
  })
  validate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ValidateWorkflowDto,
  ): Promise<ValidateWorkflowResponse> {
    return this.workflows.validate(id, dto.graph);
  }
}
