import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DOCUMENT_CATEGORIES,
  WORKFLOW_NODE_EVENTS,
  WORKFLOW_RUN_EVENTS,
  WORKFLOW_RUN_STATUSES,
  type DocumentCategory,
  type WorkflowGraph,
  type WorkflowNodeDraft,
  type WorkflowNodeEventType,
  type WorkflowRunEventType,
  type WorkflowRunStatus,
  type WorkflowTrigger,
} from '@knowledge/contracts';

/**
 * Dynamic document workflows (docs/features/17).
 *
 * The graph itself is validated structurally by `compileDefinition` rather than
 * by class-validator: the rules that matter (a step id resolves, the graph
 * terminates, an AI step has a prompt) are relationships between steps, which
 * per-field decorators cannot express. class-validator's job here is only to
 * keep the outer envelope honest.
 */

export class WorkflowGraphDto {
  /**
   * `additionalProperties: true` rather than a bare `type: Object`: a typeless
   * object schema makes `openapi-typescript` emit `Record<string, never>`, which
   * rejects every real step at the call site. The shape itself is checked by
   * `compileDefinition`, not by decorators — the rules that matter are
   * relationships between steps, which per-field validation cannot express.
   */
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'WorkflowStep[] — validated by the compiler',
  })
  @IsArray()
  steps!: WorkflowGraph['steps'];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Editor canvas coordinates, keyed by step id',
  })
  @IsOptional()
  @IsObject()
  layout?: WorkflowGraph['layout'];
}

export class WorkflowTriggerDto {
  @ApiPropertyOptional({ description: 'Offer a Run button on matching pages' })
  @IsOptional()
  @IsBoolean()
  manual?: boolean;

  @ApiPropertyOptional({
    description:
      'Start a run automatically when one of `events` fires on a matching page. ' +
      'Defaults false — an always-on trigger is how a workspace gets an LLM avalanche.',
  })
  @IsOptional()
  @IsBoolean()
  autoStart?: boolean;

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES, isArray: true, description: 'Empty = every category' })
  @IsOptional()
  @IsArray()
  @IsIn(DOCUMENT_CATEGORIES, { each: true })
  categories?: DocumentCategory[];
}

export class CreateWorkflowDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Null = every project' })
  @IsOptional()
  @ValidateIf((o: CreateWorkflowDto) => o.projectId !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: CreateWorkflowDto) => o.description !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ type: WorkflowGraphDto })
  @ValidateNested()
  @Type(() => WorkflowGraphDto)
  graph!: WorkflowGraph;

  @ApiPropertyOptional({ type: WorkflowTriggerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowTriggerDto)
  trigger?: WorkflowTrigger;

  /** Described rather than defaulted: a `default:` promotes it to required in
   *  the generated client. */
  @ApiPropertyOptional({ description: 'Defaults to true' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateWorkflowDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateWorkflowDto) => o.description !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateWorkflowDto) => o.projectId !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional({ type: WorkflowGraphDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowGraphDto)
  graph?: WorkflowGraph;

  @ApiPropertyOptional({ type: WorkflowTriggerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowTriggerDto)
  trigger?: WorkflowTrigger;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ListWorkflowsQueryDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Definitions scoped to this project, plus workspace-wide ones' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class ValidateWorkflowDto {
  @ApiPropertyOptional({ type: WorkflowGraphDto, description: 'Defaults to the stored graph' })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowGraphDto)
  graph?: WorkflowGraph;
}

export class StartWorkflowRunDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsUUID()
  definitionId!: string;

  @ApiProperty()
  @IsUUID()
  rootDocumentId!: string;

  @ApiPropertyOptional({ description: 'Extra instructions for this run only' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}

export class ListWorkflowRunsQueryDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  definitionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({ enum: WORKFLOW_RUN_STATUSES })
  @IsOptional()
  @IsIn(WORKFLOW_RUN_STATUSES)
  status?: WorkflowRunStatus;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Defaults to 25, max 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class WorkflowNodeDraftDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  title!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200_000)
  markdown!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  frontmatter?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } })
  @IsOptional()
  @IsArray()
  relations?: WorkflowNodeDraft['relations'];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;
}

export class UpdateWorkflowNodeDto {
  @ApiProperty({ type: WorkflowNodeDraftDto })
  @ValidateNested()
  @Type(() => WorkflowNodeDraftDto)
  draft!: WorkflowNodeDraft;
}

export class WorkflowNodeEventDto {
  @ApiProperty({ enum: WORKFLOW_NODE_EVENTS })
  @IsIn(WORKFLOW_NODE_EVENTS)
  type!: WorkflowNodeEventType;

  /** APPROVE may carry a last-moment edit, so review and edit are one action. */
  @ApiPropertyOptional({ type: WorkflowNodeDraftDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowNodeDraftDto)
  draft?: WorkflowNodeDraft;
}

export class WorkflowRunEventDto {
  @ApiProperty({ enum: WORKFLOW_RUN_EVENTS })
  @IsIn(WORKFLOW_RUN_EVENTS)
  type!: WorkflowRunEventType;
}
