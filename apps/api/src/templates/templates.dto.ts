import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { BUILT_IN_TEMPLATE_KEYS, type TemplateValues } from '@knowledge/contracts';
import { TEMPLATE_MAX_SOURCE_CHARS } from './templates.constants.js';

/**
 * Page templates (issue #69).
 *
 * The source is validated by `parseTemplateSource`, not by decorators: what
 * matters (a relation the graph would accept, a placeholder that is declared)
 * is a relationship inside the markdown, which per-field validation cannot
 * express. The decorators keep the envelope honest.
 */

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class ListTemplatesQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Adds this project’s templates to the workspace-wide ones' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Include archived templates and hidden built-ins (the settings view). Off by default.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeArchived?: boolean;
}

export class WorkspaceQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class TemplateVersionQueryDto {
  @ApiPropertyOptional({ description: 'A past version; the current one when omitted' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

export class BuiltInTemplateQueryDto extends WorkspaceQueryDto {
  @ApiPropertyOptional({ description: 'A past version; the current one when omitted' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

export class CreateTemplateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'Scope the template to one project; omit for workspace-wide, which needs `admin`',
  })
  @IsOptional()
  @ValidateIf((o: CreateTemplateDto) => o.projectId !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional({
    enum: BUILT_IN_TEMPLATE_KEYS,
    description:
      'Override this built-in for the workspace (`admin`): with `source` to customise it, with `enabled: false` to hide it',
  })
  @IsOptional()
  @IsIn(BUILT_IN_TEMPLATE_KEYS as unknown as string[])
  builtInKey?: string;

  @ApiPropertyOptional({ description: 'Required for a custom template; a built-in override inherits the built-in name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'An emoji' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  icon?: string | null;

  @ApiPropertyOptional({
    description: 'Markdown with frontmatter; the reserved `template:` key carries category, titlePattern and placeholders',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_MAX_SOURCE_CHARS)
  source?: string;

  @ApiPropertyOptional({ description: 'False hides a built-in from the gallery' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateTemplateDto) => o.description !== null)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateTemplateDto) => o.icon !== null)
  @IsString()
  @MaxLength(16)
  icon?: string | null;

  @ApiPropertyOptional({ description: 'A changed source appends a new version; an identical one does not' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_MAX_SOURCE_CHARS)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class RenderTemplateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ description: 'A template uuid or `builtin:<key>`', example: 'builtin:adr' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ref!: string;

  @ApiPropertyOptional({ description: 'Pin a version; the current one when omitted' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  version?: number;

  @ApiPropertyOptional({ description: 'The page title as typed — the `{{title}}` system placeholder' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Placeholder values by name: text, an ISO date, or a user/page id, by kind',
  })
  @IsOptional()
  @IsObject()
  values?: TemplateValues;

  @ApiPropertyOptional({ format: 'uuid', description: 'Fills `{{project}}`' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Fills `{{parent}}`' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
