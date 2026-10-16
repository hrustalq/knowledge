import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { COMPONENT_DRAFT_MAX_PATHS } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';
import { MAX_USAGE_LIMIT } from './component-match.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?symbols=A,B` → `['A', 'B']`; repeated `?symbols=` params arrive as an array already. */
const toList = ({ value }: { value: unknown }) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

export class ComponentUsagesQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Comma-separated export names a use must import; replaces the page\'s declared `symbols` when given',
  })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  symbols?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_USAGE_LIMIT, description: 'Usage sites to list; defaults to 200' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(MAX_USAGE_LIMIT, { message: vmsg('max') })
  limit?: number;
}

export class CodeUsagesQueryDto extends ComponentUsagesQueryDto {
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ description: 'A file, a directory or a glob, relative to the repository root' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000, { message: vmsg('maxLength') })
  path!: string;

  @ApiPropertyOptional({
    description: 'owner/repo, or any tail of the connector\'s URL; optional when the workspace has one code connector',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  repository?: string;
}

/** POST /v1/components/drafts (#236, phase 5): what to document, and where the page goes. */
export class DraftComponentDto {
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({
    type: [String],
    description: `Repo-relative files the component is made of — not globs or directories; at most ${COMPONENT_DRAFT_MAX_PATHS}`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COMPONENT_DRAFT_MAX_PATHS)
  @IsString({ each: true })
  @MaxLength(1000, { each: true, message: vmsg('maxLength') })
  paths!: string[];

  @ApiPropertyOptional({ description: 'The codebase connector; optional when the workspace has exactly one' })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  connectorId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Export names the page documents; narrows its usages to them' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true, message: vmsg('maxLength') })
  symbols?: string[];

  @ApiPropertyOptional({ description: 'The component name and page title; the first file\'s name when absent' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ description: 'The project the page goes in; the connector\'s destination when absent' })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  projectId?: string;

  @ApiPropertyOptional({ description: 'The page to nest it under' })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  parentId?: string;
}
