import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';
import { SOURCE_INTERVALS_MIN, SOURCE_MISALIGNMENT_MODES, SOURCE_RECIPE_RULE_KINDS, type SourceMisalignmentMode } from '@knowledge/contracts';

/** POST /v1/sources — "Add page → Link a source" (#674). */
export class CreateSourcePageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiProperty({ maxLength: 2000, description: 'A markdown file or an HTML page, https' })
  @IsString()
  @MaxLength(2000)
  url!: string;

  @ApiPropertyOptional({ maxLength: 200, description: "The page title. Empty: the source's own title" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, enum: SOURCE_INTERVALS_MIN, description: 'Minutes between checks; null = only on demand. Omitted reads as 60' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn([...SOURCE_INTERVALS_MIN])
  intervalMinutes?: number | null;

  @ApiPropertyOptional({ maxLength: 4000, description: 'For a host that needs one: a token (sent as Bearer) or `Header-Name: value`. Saved as a connection for the host' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  credential?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Also sync every page under this URL, nested beneath this one. Omitted reads as false' })
  @IsOptional()
  @IsBoolean()
  crawl?: boolean;
}

/** GET /v1/sources/settings */
export class SourceSettingsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

/** PUT /v1/sources/settings — each null inherits its WEB_SOURCE_CRAWL_* ceiling, which a value may only lower. */
export class UpdateSourceSettingsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, description: 'Pages one crawl reads; null = WEB_SOURCE_CRAWL_MAX_PAGES' })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  maxPages!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'New pages a first crawl may create before it waits for a person; null = WEB_SOURCE_CRAWL_CONFIRM_FIRST' })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  confirmFirst!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Pages a later crawl may add plus drop before it waits for a person; null = WEB_SOURCE_CRAWL_CONFIRM_CHANGE' })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  confirmChange!: number | null;
}

/** PATCH /v1/documents/:id/source — each field omitted is left as it is. */
export class UpdateDocumentSourceDto {
  @ApiPropertyOptional({ type: Number, nullable: true, enum: SOURCE_INTERVALS_MIN, description: 'Minutes between checks; null = only on demand' })
  @IsOptional()
  @IsIn([...SOURCE_INTERVALS_MIN])
  intervalMinutes?: number | null;

  @ApiPropertyOptional({ enum: SOURCE_MISALIGNMENT_MODES, description: 'A page linking this source that a new version may have made wrong: flagged for its owner, or flagged with a proposed fix' })
  @IsOptional()
  @IsIn([...SOURCE_MISALIGNMENT_MODES])
  misalignment?: SourceMisalignmentMode;
}

/** POST /v1/documents/:id/source/restore */
export class RestoreDocumentSourceDto {
  @ApiProperty({ format: 'uuid', description: 'An earlier revision of this page' })
  @IsUUID()
  revisionId!: string;
}

/**
 * An extraction recipe (#674, phase 2). Declared here for the client's types
 * only: `readRecipe` is the validator, and the one place a recipe is reduced
 * to its shape whoever sent it.
 */
export class SourceRecipeRuleDto {
  @ApiProperty({ enum: SOURCE_RECIPE_RULE_KINDS })
  kind!: 'drop-section' | 'rename-heading' | 'rewrite-links';

  @ApiPropertyOptional({ description: 'drop-section: the heading whose section is removed' })
  heading?: string;

  @ApiPropertyOptional({ description: 'rename-heading: the heading text; rewrite-links: the link prefix' })
  from?: string;

  @ApiPropertyOptional({ description: 'rename-heading: the new text; rewrite-links: the replacement prefix' })
  to?: string;
}

export class SourceRecipeDto {
  @ApiProperty({ type: [String], description: 'CSS selectors for the content, first that matches wins. Empty = article scoring' })
  content!: string[];

  @ApiProperty({ type: [String], description: 'CSS selectors removed first' })
  strip!: string[];

  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' }, description: 'h1…h6 → the markdown level (1–6) it becomes' })
  headings!: Record<string, number>;

  @ApiProperty({ type: [String], description: 'CSS selectors that must each match, or the version is held' })
  landmarks!: string[];

  @ApiProperty({ type: [SourceRecipeRuleDto] })
  rules!: SourceRecipeRuleDto[];
}

/** POST /v1/documents/:id/source/recipe/preview */
export class PreviewSourceRecipeDto {
  @ApiProperty({ type: SourceRecipeDto })
  @IsObject()
  recipe!: SourceRecipeDto;
}

/** PUT /v1/documents/:id/source/recipe */
export class SaveSourceRecipeDto extends PreviewSourceRecipeDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The drafted recipe this approves, if any' })
  @IsOptional()
  @IsUUID()
  proposalId?: string;
}

const TREE_PAGE = 'A crawled page of this connector to read the last version of. Omitted: the root page';

/** POST /v1/connectors/:id/source/recipe/draft */
export class DraftSourceTreeRecipeDto {
  @ApiPropertyOptional({ format: 'uuid', description: TREE_PAGE })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

/** POST /v1/connectors/:id/source/recipe/preview */
export class PreviewSourceTreeRecipeDto extends PreviewSourceRecipeDto {
  @ApiPropertyOptional({ format: 'uuid', description: TREE_PAGE })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

/** PUT /v1/connectors/:id/source/recipe */
export class SaveSourceTreeRecipeDto extends SaveSourceRecipeDto {
  @ApiPropertyOptional({ format: 'uuid', description: `${TREE_PAGE}. Its checks must pass for the recipe to be saved` })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}
