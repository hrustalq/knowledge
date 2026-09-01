import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ImpactAnalysisDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ enum: ['dependents', 'dependencies'], default: 'dependents' })
  @IsOptional()
  @IsIn(['dependents', 'dependencies'])
  direction?: 'dependents' | 'dependencies';

  @ApiPropertyOptional({ default: 3, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxDepth?: number;
}
