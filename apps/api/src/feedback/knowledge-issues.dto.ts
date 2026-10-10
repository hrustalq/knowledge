import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  KNOWLEDGE_ISSUE_CLOSE_STATUSES,
  KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS,
  KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS,
  KNOWLEDGE_ISSUE_EVIDENCE_MAX,
  KNOWLEDGE_ISSUE_KINDS,
  KNOWLEDGE_ISSUE_STATUSES,
  KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS,
  KNOWLEDGE_ISSUE_SURFACES,
  type KnowledgeIssueKind,
  type KnowledgeIssueStatus,
  type KnowledgeIssueSurface,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class KnowledgeIssueEvidenceDto {
  @ApiPropertyOptional({ maxLength: KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS, description: 'A passage of the page the report disputes' })
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS, { message: vmsg('maxLength') })
  quote?: string;

  @ApiPropertyOptional({ maxLength: KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS, description: 'Where the correct information is' })
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS, { message: vmsg('maxLength') })
  url?: string;

  @ApiPropertyOptional({ maxLength: KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS })
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS, { message: vmsg('maxLength') })
  note?: string;
}

export class ReportKnowledgeIssueDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid', description: 'The page the report is about; must belong to workspaceId' })
  @IsUUID()
  documentId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The revision the reporter read' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;

  @ApiProperty({ enum: KNOWLEDGE_ISSUE_KINDS })
  @IsIn(KNOWLEDGE_ISSUE_KINDS)
  kind!: KnowledgeIssueKind;

  @ApiProperty({ maxLength: KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS, description: 'What is wrong, in the reporter\'s words' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS, { message: vmsg('maxLength') })
  detail!: string;

  @ApiPropertyOptional({ type: [KnowledgeIssueEvidenceDto], description: `At most ${KNOWLEDGE_ISSUE_EVIDENCE_MAX} items` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWLEDGE_ISSUE_EVIDENCE_MAX, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => KnowledgeIssueEvidenceDto)
  evidence?: KnowledgeIssueEvidenceDto[];

  @ApiPropertyOptional({
    maxLength: KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS,
    description:
      'A corrected page body (markdown, no frontmatter). From an editor it opens a draft merge request at once; ' +
      'from a viewer it only reaches the sentinel as evidence.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS, { message: vmsg('maxLength') })
  suggestedMarkdown?: string;

  @ApiPropertyOptional({
    enum: KNOWLEDGE_ISSUE_SURFACES,
    description: 'Where the report was made. Omitted reads as "web" (the page itself).',
  })
  @IsOptional()
  @IsIn(KNOWLEDGE_ISSUE_SURFACES)
  surface?: KnowledgeIssueSurface;
}

export class ListKnowledgeIssuesQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({ enum: KNOWLEDGE_ISSUE_STATUSES })
  @IsOptional()
  @IsIn(KNOWLEDGE_ISSUE_STATUSES)
  status?: KnowledgeIssueStatus;
}

export class CloseKnowledgeIssueDto {
  @ApiProperty({ enum: KNOWLEDGE_ISSUE_CLOSE_STATUSES, description: 'The only two states a person sets by hand' })
  @IsIn(KNOWLEDGE_ISSUE_CLOSE_STATUSES)
  status!: 'resolved' | 'dismissed';
}
