import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import {
  ANALYTICS_MAX_DAYS,
  ANALYTICS_REPORTS,
  ANALYTICS_TRAFFIC_FILTERS,
  type AnalyticsReport,
  type AnalyticsTrafficFilter,
} from '@knowledge/contracts';

const NULLABLE = <T extends object>(field: keyof T) => ValidateIf((o: T) => o[field] !== null);

export class RecordPageViewDto {
  @ApiProperty({ format: 'uuid', description: "The page's own id for this view; a replay is a no-op" })
  @IsUUID()
  viewId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The revision shown' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The search this page was opened from (`searchId` of the search response)' })
  @IsOptional()
  @IsUUID()
  searchId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, description: '1-based rank of the clicked result' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  searchRank?: number;

  @ApiPropertyOptional({ description: 'The browser asked not to be tracked (Global Privacy Control): counted, never tied to a reader' })
  @IsOptional()
  @IsBoolean()
  noTrack?: boolean;
}

export class PageViewHeartbeatDto {
  @ApiProperty({ minimum: 0, description: 'Active read time of the view so far, in ms — the total, not a delta' })
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  activeMs!: number;

  @ApiPropertyOptional({ description: 'As on the view: must match it, or the heartbeat changes nothing' })
  @IsOptional()
  @IsBoolean()
  noTrack?: boolean;
}

export class ProjectAnalyticsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: ANALYTICS_MAX_DAYS, description: 'Days back from now. Omitted: 30' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_MAX_DAYS)
  days?: number;

  @ApiPropertyOptional({ enum: ANALYTICS_TRAFFIC_FILTERS, description: 'Count one traffic class only. Omitted: all' })
  @IsOptional()
  @IsIn(ANALYTICS_TRAFFIC_FILTERS)
  traffic?: AnalyticsTrafficFilter;
}

export class AnalyticsWorkspaceQueryDto extends ProjectAnalyticsQueryDto {
  // Field name must stay `workspaceId`: @Access('admin', 'query') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class AnalyticsExportQueryDto extends AnalyticsWorkspaceQueryDto {
  @ApiProperty({ enum: ANALYTICS_REPORTS, description: 'Which dashboard table' })
  @IsIn(ANALYTICS_REPORTS)
  report!: AnalyticsReport;
}

export class AnalyticsSettingsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class UpdateAnalyticsSettingsDto {
  // Field name must stay `workspaceId`: @Access('admin', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ type: Boolean, nullable: true, description: 'Record usage here; null inherits ANALYTICS_ENABLED, which true cannot exceed' })
  @NULLABLE<UpdateAnalyticsSettingsDto>('enabled')
  @IsBoolean()
  enabled!: boolean | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 3650,
    description: 'Days rows are kept; null inherits ANALYTICS_RETENTION_DAYS, and a longer value is clamped to it',
  })
  @NULLABLE<UpdateAnalyticsSettingsDto>('retentionDays')
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays!: number | null;
}
