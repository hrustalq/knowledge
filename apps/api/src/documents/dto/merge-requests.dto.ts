import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { vmsg } from '../../common/validation.js';

/**
 * Permissive UUID shape (any version digit, nil allowed) — class-validator's
 * @IsUUID rejects the zeros AUTHOR_ID_STUB used when no principal exists.
 * Mirrors UUID_RE in acl.guard.ts.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A text anchor stores the passage it was left on, so it stays bounded: a
 * whole-page selection is a comment on the page, not on a passage, and the
 * review canvas offers an unanchored thread for that.
 */
const MAX_QUOTE_CHARS = 1_000;
const MAX_CONTEXT_CHARS = 100;

/**
 * A remark, not a document — an order of magnitude under the inline-page cap.
 * These two classes serve BOTH merge-request threads and page comments
 * (documents.controller.ts imports them), so this bounds all four surfaces.
 */
const MAX_BODY_CHARS = 50_000;

export class CreateMergeRequestDto {
  @ApiProperty({ example: 'feature/oauth' })
  @IsString()
  @IsNotEmpty()
  sourceBranch!: string;

  @ApiPropertyOptional({ description: "Defaults to the document's default branch", example: 'main' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetBranch?: string;

  @ApiProperty({ example: 'Shorten access-token TTL' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class MergeMergeRequestDto {
  @ApiPropertyOptional({ enum: ['merge-commit', 'squash'], default: 'merge-commit' })
  @IsOptional()
  @IsIn(['merge-commit', 'squash'])
  strategy?: 'merge-commit' | 'squash';
}

export class UpdateMergeRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Draft merge requests cannot be merged' })
  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @ApiPropertyOptional({ description: 'Workspace member to assign; null clears the assignee', type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateMergeRequestDto) => o.assigneeId !== null)
  @Matches(UUID_RE)
  assigneeId?: string | null;
}

export class SetReviewersDto {
  @ApiProperty({ type: [String], description: 'Replace-set of reviewer user ids (workspace members)' })
  @IsString({ each: true })
  @Matches(UUID_RE, { each: true })
  reviewerIds!: string[];
}

export class ListMergeRequestsQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({ enum: ['open', 'merged', 'closed'] })
  @IsOptional()
  @IsIn(['open', 'merged', 'closed'])
  status?: 'open' | 'merged' | 'closed';

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(UUID_RE)
  authorId?: string;

  @ApiPropertyOptional({ description: 'Only merge requests with this user as the single assignee' })
  @IsOptional()
  @Matches(UUID_RE)
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Only merge requests with this user assigned as reviewer' })
  @IsOptional()
  @Matches(UUID_RE)
  reviewerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(UUID_RE)
  documentId?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive substring match on the source branch name' })
  @IsOptional()
  @IsString()
  sourceBranch?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive substring match on the target branch name' })
  @IsOptional()
  @IsString()
  targetBranch?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive title substring match' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(100, { message: vmsg('max') })
  limit?: number;
}

/**
 * Kept deliberately loose: the per-type shape (line needs revisionId+line,
 * text needs revisionId+quote, section needs heading, entity needs entityKey)
 * is validated in MergeRequestThreadsService to avoid polymorphic
 * nested-validator setups.
 */
export class ThreadAnchorDto {
  @ApiProperty({ enum: ['line', 'text', 'section', 'entity'] })
  @IsIn(['line', 'text', 'section', 'entity'])
  type!: 'line' | 'text' | 'section' | 'entity';

  @ApiPropertyOptional({ description: 'line: revision the line number refers to (source head at comment time)' })
  @IsOptional()
  @Matches(UUID_RE)
  revisionId?: string;

  @ApiPropertyOptional({ description: 'line: 1-based new-side line number in the diff' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  line?: number;

  @ApiPropertyOptional({ description: 'line: text excerpt for best-effort re-matching once the branch advances' })
  @IsOptional()
  @IsString()
  excerpt?: string;

  @ApiPropertyOptional({ description: 'text: the selected passage, as rendered (feature 13 review mode)' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUOTE_CHARS, { message: vmsg('maxLength') })
  quote?: string;

  @ApiPropertyOptional({ description: 'text: rendered text immediately before the quote, for disambiguation' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTEXT_CHARS, { message: vmsg('maxLength') })
  prefix?: string;

  @ApiPropertyOptional({ description: 'text: rendered text immediately after the quote, for disambiguation' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTEXT_CHARS, { message: vmsg('maxLength') })
  suffix?: string;

  @ApiPropertyOptional({ description: 'section: markdown heading text' })
  @IsOptional()
  @IsString()
  heading?: string;

  @ApiPropertyOptional({ description: 'entity: graph entity key, e.g. service:identity' })
  @IsOptional()
  @IsString()
  entityKey?: string;
}

export class CreateThreadDto {
  @ApiProperty({ maxLength: MAX_BODY_CHARS })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BODY_CHARS, { message: vmsg('maxLength') })
  body!: string;

  @ApiPropertyOptional({ type: ThreadAnchorDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThreadAnchorDto)
  anchor?: ThreadAnchorDto;

  // No `default:` in the decorator on purpose: openapi-typescript promotes any
  // property that declares one to required, forcing every caller to send a
  // value the server already fills in.
  @ApiPropertyOptional({
    description:
      'True (the default) starts a resolvable thread; false posts a plain comment that cannot be resolved.',
  })
  @IsOptional()
  @IsBoolean()
  resolvable?: boolean;

  @ApiPropertyOptional({
    enum: ['human', 'ai'],
    description: "Who opened it. Defaults to 'human'; 'ai' marks a finding posted from an assistant review.",
  })
  @IsOptional()
  @IsIn(['human', 'ai'])
  source?: 'human' | 'ai';
}

export class CreateCommentDto {
  @ApiProperty({ maxLength: MAX_BODY_CHARS })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BODY_CHARS, { message: vmsg('maxLength') })
  body!: string;

  /**
   * Which comment in this thread the reply answers. Attribution only — the
   * comment list stays flat — so an id from another thread is rejected rather
   * than stored as a pointer nothing can render.
   */
  @ApiPropertyOptional({ description: 'Comment in this thread that the reply answers' })
  @IsOptional()
  @Matches(UUID_RE)
  replyToId?: string;
}

export class ResolveThreadDto {
  @ApiProperty()
  @IsBoolean()
  resolved!: boolean;
}
