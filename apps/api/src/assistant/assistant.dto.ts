import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { ASSISTANT_DRAFT_MAX_CHARS, ASSISTANT_MESSAGE_MAX_CHARS, FLOW_KEYS, FLOW_TEXT_MAX_CHARS } from '@knowledge/contracts';
import type { FlowAnswer, FlowKey } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class AssistantReviewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000, { message: vmsg('maxLength') })
  markdown!: string;
}

export class AssistantLintDto extends AssistantReviewDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: "The project the text belongs to: its styleguide applies, else the workspace's (#74)",
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class AssistantSuggestDto extends AssistantReviewDto {
  @ApiProperty({ example: 'Draft an outline for the missing sections' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  instruction!: string;
}

export class AssistantRelatedDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ description: 'Draft text (an excerpt is used as the search query)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000, { message: vmsg('maxLength') })
  text!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: 'Default: 5.' })
  @IsOptional()
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(20, { message: vmsg('max') })
  limit?: number;
}

export class AssistantAskTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  // Must track the live message cap, or a turn long enough to send becomes too
  // long to replay as history on the next one.
  @ApiProperty({ maxLength: ASSISTANT_MESSAGE_MAX_CHARS })
  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSISTANT_MESSAGE_MAX_CHARS, { message: vmsg('maxLength') })
  content!: string;
}

export class CreateAssistantThreadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Page the pane was opened from — default chat grounding' })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  title?: string;
}

export class UpdateAssistantThreadDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'null clears the manual title so the auto-derived one shows again',
  })
  @IsOptional()
  @ValidateIf((o: UpdateAssistantThreadDto) => o.title !== null)
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  title?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Provider profile to run this thread on; null returns it to the workspace default',
  })
  @IsOptional()
  @ValidateIf((o: UpdateAssistantThreadDto) => o.providerId !== null)
  @IsUUID()
  providerId?: string | null;
}

export class ListAssistantThreadsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Case-insensitive substring over the title and the messages' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  search?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Default: 50.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(100, { message: vmsg('max') })
  limit?: number;

  @ApiPropertyOptional({ description: 'updatedAt of the last row of the previous page (keyset cursor)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ChatAttachmentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  filename!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20_000, { message: vmsg('maxLength') })
  content!: string;
}

/** The template a new page was started from (issue #69). */
export class AssistantDraftTemplateDto {
  @ApiProperty({ description: 'A template id or builtin:<key>', example: 'builtin:adr' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100, { message: vmsg('maxLength') })
  ref!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  version!: number;
}

/** The page as it stands in the author's editor (docs/features/34). */
export class AssistantDraftDto {
  @ApiProperty({ description: 'The title field as typed, which may differ from the published title' })
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  title!: string;

  @ApiProperty({ maxLength: ASSISTANT_DRAFT_MAX_CHARS, description: 'The body markdown, unstaged edits included' })
  @IsString()
  @MaxLength(ASSISTANT_DRAFT_MAX_CHARS, { message: vmsg('maxLength') })
  markdown!: string;

  @ApiPropertyOptional({
    type: AssistantDraftTemplateDto,
    description:
      'The template this new page started from. The turn is told the draft is a skeleton to fill in; a ref ' +
      'the workspace cannot resolve is ignored.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssistantDraftTemplateDto)
  template?: AssistantDraftTemplateDto;
}

/**
 * One answered step of a question flow (#425). Shape only: whether the value
 * is one of the question's options is decided against the rebuilt flow, which
 * is the only place the options exist.
 */
export class AssistantFlowAnswerDto {
  @ApiProperty({ enum: FLOW_KEYS })
  @IsIn(FLOW_KEYS)
  flow!: FlowKey;

  @ApiProperty({ example: 'project' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60, { message: vmsg('maxLength') })
  questionId!: string;

  @ApiProperty({
    nullable: true,
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'An option value, the ticked values of a checklist, free text, or null to skip an optional question',
  })
  // A string, or an array of them: `each` validates the elements of an array
  // and the value itself otherwise.
  @ValidateIf((_, value) => value !== null)
  @IsString({ each: true })
  @MaxLength(FLOW_TEXT_MAX_CHARS, { each: true, message: vmsg('maxLength') })
  value!: FlowAnswer;
}

export class PostAssistantMessageDto {
  @ApiProperty({
    example: 'Draft a short onboarding page for new hires',
    maxLength: ASSISTANT_MESSAGE_MAX_CHARS,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSISTANT_MESSAGE_MAX_CHARS, { message: vmsg('maxLength') })
  content!: string;

  @ApiPropertyOptional({ format: 'uuid', description: "Overrides the thread's default grounding document for this turn" })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({
    enum: ['ask', 'agent'],
    description: "'ask' (default) excludes write tools this turn regardless of role; 'agent' allows them (still gated by editor role)",
  })
  @IsOptional()
  @IsIn(['ask', 'agent'])
  mode?: 'ask' | 'agent';

  @ApiPropertyOptional({
    description:
      "Agent to run this turn (docs/features/20). 'auto' asks the router to choose. " +
      'Omitted, the mode picks: researcher for ask, author for agent. The mode is still the ceiling — ' +
      'an agent can never gain write tools in ask mode.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: vmsg('maxLength') })
  agentKey?: string;

  @ApiPropertyOptional({
    type: [ChatAttachmentDto],
    description: 'Ephemeral file content for this turn only — not persisted verbatim into thread history',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => ChatAttachmentDto)
  attachments?: ChatAttachmentDto[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Existing workspace documents manually picked to ground this turn in ("Apply documents" widget)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, { message: vmsg('arrayMaxSize') })
  @IsUUID(undefined, { each: true })
  documentRefs?: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Skills (docs/features/12) explicitly applied to this turn; enabled skills also join on trigger match',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, { message: vmsg('arrayMaxSize') })
  @IsUUID(undefined, { each: true })
  skillIds?: string[];

  @ApiPropertyOptional({
    type: AssistantDraftDto,
    description:
      "The author's working copy, sent from the editor. Grounds the turn in it instead of the published page " +
      'and offers edit_draft, whose edits stream back as draft-edit frames and are never saved server-side.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssistantDraftDto)
  draft?: AssistantDraftDto;

  @ApiPropertyOptional({
    type: AssistantFlowAnswerDto,
    description:
      "Set when this message answers the open step of a question flow (#425); `content` is the readable " +
      'form the transcript shows. An answer to anything but the open question (or the one answered last) is a 409.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssistantFlowAnswerDto)
  answer?: AssistantFlowAnswerDto;
}

export class AssistantAskDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId!: string;

  @ApiProperty({
    example: 'Why do sessions get revoked on password reset?',
    maxLength: ASSISTANT_MESSAGE_MAX_CHARS,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSISTANT_MESSAGE_MAX_CHARS, { message: vmsg('maxLength') })
  question!: string;

  @ApiPropertyOptional({ type: [AssistantAskTurnDto], description: 'Prior turns, most recent last' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => AssistantAskTurnDto)
  history?: AssistantAskTurnDto[];
}
