import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
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
