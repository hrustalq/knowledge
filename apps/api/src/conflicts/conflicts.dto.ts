import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CONFLICT_KINDS, CONFLICT_STATUSES, type ConflictKind, type ConflictStatus } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class ListConflictsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ enum: CONFLICT_STATUSES, description: 'Every status when absent' })
  @IsOptional()
  @IsIn(CONFLICT_STATUSES)
  status?: ConflictStatus;

  @ApiPropertyOptional({ enum: CONFLICT_KINDS })
  @IsOptional()
  @IsIn(CONFLICT_KINDS)
  kind?: ConflictKind;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only conflicts with this page on either side' })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

export class CloseConflictDto {
  @ApiPropertyOptional({ maxLength: 1000, description: 'Why — kept on the conflict' })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  note?: string;
}
