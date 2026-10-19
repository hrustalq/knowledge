import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

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
