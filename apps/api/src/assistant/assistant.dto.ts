import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
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

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 20 })
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

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000, { message: vmsg('maxLength') })
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

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
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

export class PostAssistantMessageDto {
  @ApiProperty({ example: 'Draft a short onboarding page for new hires' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000, { message: vmsg('maxLength') })
  content!: string;

  @ApiPropertyOptional({ format: 'uuid', description: "Overrides the thread's default grounding document for this turn" })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({
    enum: ['ask', 'agent'],
    default: 'ask',
    description: "'ask' (default) excludes write tools this turn regardless of role; 'agent' allows them (still gated by editor role)",
  })
  @IsOptional()
  @IsIn(['ask', 'agent'])
  mode?: 'ask' | 'agent';

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
}

export class AssistantAskDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ example: 'Why do sessions get revoked on password reset?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000, { message: vmsg('maxLength') })
  question!: string;

  @ApiPropertyOptional({ type: [AssistantAskTurnDto], description: 'Prior turns, most recent last' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => AssistantAskTurnDto)
  history?: AssistantAskTurnDto[];
}
