import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, type AuditCategory } from '@knowledge/contracts';

export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/** The audit filter (#1251), shared by the listing and the export so a download is what the screen showed. */
export class AuditFilterQueryDto {
  @ApiPropertyOptional({ enum: AUDIT_ACTIONS, description: 'One AUDIT_ACTIONS value' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @ApiPropertyOptional({ enum: AUDIT_CATEGORIES, description: 'Derived from the action (auditCategoryOf)' })
  @IsOptional()
  @IsIn(AUDIT_CATEGORIES)
  category?: AuditCategory;

  @ApiPropertyOptional({ description: 'users.id, or a synthetic actor such as "dev" or "anonymous"' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actor?: string;

  @ApiPropertyOptional({ description: 'Who or what the action was done to: a user id, a provider id' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  target?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on createdAt, ISO 8601' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on createdAt, ISO 8601' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Only succeeded (true) or failed (false) entries' })
  @IsOptional()
  @IsIn(['true', 'false'])
  ok?: 'true' | 'false';
}

export class AuditPageQueryDto extends AuditFilterQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'Omitted: 50' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'nextCursor from the previous page' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class WorkspaceAuditPageQueryDto extends AuditPageQueryDto {
  // Field name must stay `workspaceId`: @Access('admin', 'query') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class AuditExportQueryDto extends AuditFilterQueryDto {
  @ApiProperty({ enum: AUDIT_EXPORT_FORMATS })
  @IsIn(AUDIT_EXPORT_FORMATS)
  format!: AuditExportFormat;
}

export class WorkspaceAuditExportQueryDto extends AuditExportQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}
