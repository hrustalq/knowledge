import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
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
  AUTHORABLE_RELATION_TYPES,
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
import { vmsg } from '../common/validation.js';

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
  @MinLength(1, { message: vmsg('minLength') })
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: CreateWorkflowDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
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
  @MinLength(1, { message: vmsg('minLength') })
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateWorkflowDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
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

/**
 * One turn of the architect conversation (docs/features/17).
 *
 * `role` is a two-value enum rather than the assistant's full message union:
 * this transcript has no system or tool turns, and accepting one would let a
 * caller inject instructions into a prompt the server owns.
 */
export class WorkflowDraftMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MaxLength(4000, { message: vmsg('maxLength') })
  content!: string;
}

export class DraftWorkflowDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: DraftWorkflowDto) => o.projectId !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiProperty({ type: [WorkflowDraftMessageDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowDraftMessageDto)
  messages!: WorkflowDraftMessageDto[];

  @ApiPropertyOptional({
    type: WorkflowGraphDto,
    description: 'The proposal on screen, so a follow-up edits it instead of restarting',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowGraphDto)
  graph?: WorkflowGraph | null;
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
  @MaxLength(4000, { message: vmsg('maxLength') })
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
  @Min(1, { message: vmsg('min') })
  @Max(100, { message: vmsg('max') })
  limit?: number;
}

export class WorkflowRelationTargetDto {
  @ApiProperty({ example: 'service' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: 'service:identity' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiPropertyOptional({ example: 'Identity Service' })
  @IsOptional()
  @IsString()
  name?: string;
}

/**
 * A relation on a reviewable draft.
 *
 * Validated element by element, unlike the bare `@IsArray()` this used to carry:
 * an unrecognised edge type passed the PATCH cleanly and only failed at
 * materialize time, inside `GraphService.assertEdgeType`, once somebody had
 * already approved the node.
 */
export class WorkflowRelationDto {
  @ApiProperty({ enum: AUTHORABLE_RELATION_TYPES })
  @IsIn(AUTHORABLE_RELATION_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({ type: WorkflowRelationTargetDto })
  @ValidateNested()
  @Type(() => WorkflowRelationTargetDto)
  target!: WorkflowRelationTargetDto;
}

export class WorkflowNodeDraftDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  title!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200_000, { message: vmsg('maxLength') })
  markdown!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  frontmatter?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [WorkflowRelationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => WorkflowRelationDto)
  relations?: WorkflowNodeDraft['relations'];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
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
