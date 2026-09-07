import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts';
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
  MaxLength,
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

export class SearchFiltersDto {
  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES, isArray: true, description: 'Only return documents in these categories (feature 02)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[], { each: true })
  categories?: DocumentCategory[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Only return documents in these projects' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  projectIds?: string[];

  /**
   * Tag entity keys (`tag:<name>`) or bare names — resolved against the graph's
   * TAGGED_WITH edges, not PG. Matched with OR semantics.
   */
  @ApiPropertyOptional({ type: [String], description: 'Only return documents carrying any of these tags' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  tags?: string[];
}

export class SearchDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiPropertyOptional({ enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid' })
  @IsOptional()
  @IsIn(['hybrid', 'semantic', 'keyword'])
  mode?: 'hybrid' | 'semantic' | 'keyword';

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

  /** Feature 02 metadata filters, applied post-ranking against PG. */
  @ApiPropertyOptional({ type: SearchFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SearchFiltersDto)
  filters?: SearchFiltersDto;
}
