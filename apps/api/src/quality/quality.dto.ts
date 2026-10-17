import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { QUALITY_SORTS, type QualitySort } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class QualitySummaryQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this project; the whole workspace when absent' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class QualityListQueryDto extends QualitySummaryQueryDto {
  @ApiPropertyOptional({ enum: QUALITY_SORTS, description: 'worst (the default) | best | title | recent' })
  @IsOptional()
  @IsIn(QUALITY_SORTS)
  sort?: QualitySort;

  @ApiPropertyOptional({ maxLength: 200, description: 'Title contains' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  q?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: '50 when absent' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(100, { message: vmsg('max') })
  limit?: number;

  @ApiPropertyOptional({ description: 'nextCursor of the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: vmsg('maxLength') })
  cursor?: string;
}
