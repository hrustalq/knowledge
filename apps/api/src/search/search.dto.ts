import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ExpandGraphDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 3, description: 'Entity hops from the vector hits' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  depth?: number;

  @ApiPropertyOptional({ type: [String], description: 'Relation edge types to follow (default: all)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  relationTypes?: string[];
}

export class SearchDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiPropertyOptional({ enum: ['hybrid', 'semantic'], default: 'hybrid' })
  @IsOptional()
  @IsIn(['hybrid', 'semantic'])
  mode?: 'hybrid' | 'semantic';

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Phase 4 hybrid expansion: walk relation edges out from the vector hits. */
  @ApiPropertyOptional({ type: ExpandGraphDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExpandGraphDto)
  expandGraph?: ExpandGraphDto;
}
