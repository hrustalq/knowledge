import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ANALYTICS_MAX_DAYS, ANALYTICS_TRAFFIC_FILTERS, type AnalyticsTrafficFilter } from '@knowledge/contracts';

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
