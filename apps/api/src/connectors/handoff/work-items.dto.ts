import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { WORK_ITEM_SOURCE_KINDS, type WorkItemSourceKind } from '@knowledge/contracts';
import { vmsg } from '../../common/validation.js';

/** POST /v1/work-items/handoff (#424). */
export class WorkItemHandoffDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: WORK_ITEM_SOURCE_KINDS, description: 'What kind of knowledge object the ticket is for' })
  @IsIn(WORK_ITEM_SOURCE_KINDS as unknown as string[])
  sourceKind!: WorkItemSourceKind;

  @ApiProperty({ description: 'knowledge_issues.id, knowledge_conflicts.id, or the page id for verification/document' })
  @IsUUID()
  sourceId!: string;

  @ApiPropertyOptional({ description: "The tracker connector; omitted = the anchor's project route" })
  @IsOptional()
  @IsUUID()
  connectorId?: string;

  @ApiPropertyOptional({ description: 'Attach this existing ticket instead of creating one: BILL-123, #45, org/repo#45 or its URL' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: vmsg('isNotEmpty') })
  @MaxLength(500, { message: vmsg('maxLength') })
  attach?: string;
}

/** GET /v1/work-items — the tickets on one anchor. */
export class AnchorWorkItemsQueryDto {
  @ApiProperty()
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: WORK_ITEM_SOURCE_KINDS })
  @IsIn(WORK_ITEM_SOURCE_KINDS as unknown as string[])
  sourceKind!: WorkItemSourceKind;

  @ApiProperty()
  @IsUUID()
  sourceId!: string;
}

/** PUT /v1/projects/:id/tracker-route (#424). */
export class PutTrackerRouteDto {
  @ApiProperty({ description: 'The tracker connector this project hands off to' })
  @IsUUID()
  connectorId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Jira project key (BILL); ignored by repository trackers' })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Za-z][A-Za-z0-9_]{0,19})?$/, { message: vmsg('matches') })
  externalProject?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Jira issue type; empty is Task' })
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: vmsg('maxLength') })
  issueType?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'A GitHub organization board URL; the card follows the issue' })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  boardUrl?: string | null;
}
