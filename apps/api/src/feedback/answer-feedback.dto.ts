import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  ANSWER_FEEDBACK_COMMENT_MAX_CHARS,
  ANSWER_FEEDBACK_REASONS,
  ANSWER_RATINGS,
  type AnswerFeedbackReason,
  type AnswerRating,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** The vote itself — shared by the message route and the one-shot `/ask` route. */
export class AnswerVoteDto {
  @ApiProperty({ enum: ANSWER_RATINGS })
  @IsIn(ANSWER_RATINGS)
  rating!: AnswerRating;

  @ApiPropertyOptional({
    enum: ANSWER_FEEDBACK_REASONS,
    description: 'Required when rating is "down" (400 VALIDATION_FAILED without it); optional on "up".',
  })
  // Validated when it must be present (a down-vote) or when it was sent at
  // all, so a missing reason on a thumbs-down is a validation error rather than
  // a silently reason-less row.
  @ValidateIf((o: AnswerVoteDto) => o.rating === 'down' || o.reason !== undefined)
  @IsIn(ANSWER_FEEDBACK_REASONS)
  reason?: AnswerFeedbackReason;

  @ApiPropertyOptional({ maxLength: ANSWER_FEEDBACK_COMMENT_MAX_CHARS })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_FEEDBACK_COMMENT_MAX_CHARS, { message: vmsg('maxLength') })
  comment?: string;
}

export class SetMessageFeedbackDto extends AnswerVoteDto {
  @ApiPropertyOptional({
    enum: ['assistant', 'editor-assistant'],
    description:
      'Which pane the vote came from. The editor assistant mounts the same chat, so the client says which; ' +
      'omitted reads as "assistant".',
  })
  @IsOptional()
  @IsIn(['assistant', 'editor-assistant'])
  surface?: 'assistant' | 'editor-assistant';
}

export class AskFeedbackDto extends AnswerVoteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ maxLength: 4_000, description: 'The question the answer was for' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000, { message: vmsg('maxLength') })
  query!: string;

  @ApiPropertyOptional({ maxLength: 1_000, description: 'The start of the answer, as the voter saw it' })
  @IsOptional()
  @IsString()
  @MaxLength(1_000, { message: vmsg('maxLength') })
  answerExcerpt?: string;

  @ApiPropertyOptional({ type: [String], description: 'Document ids the answer cited (at most 20)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @IsUUID('all', { each: true })
  citedDocumentIds?: string[];
}
