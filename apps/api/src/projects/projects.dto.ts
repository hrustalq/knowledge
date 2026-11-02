import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BUILT_IN_BLUEPRINT_KEYS,
  PROJECT_DELETION_MODES,
  SUPPORTED_LOCALES,
  type BuiltInBlueprintKey,
  type Locale,
  type ProjectDeletionMode,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class ListProjectsQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Case-insensitive name/description substring match' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  /** Omitted = the whole roster in one response (what the sidebar switchers want). */
  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'Omit for the full roster' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(200, { message: vmsg('max') })
  limit?: number;
}

export class CreateProjectDto {
  // Field name must stay `workspaceId`: @Access('editor', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  // Explicit `type: String` on a nullable property — without it openapi-typescript
  // emits Record<string, never> and the web typecheck breaks at every call site.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: CreateProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  description?: string | null;
}

/** `POST /v1/projects/scaffold` (#716). The blueprint itself is parsed by `parseBlueprint`, not here. */
export class ScaffoldProjectDto {
  // Field name must stay `workspaceId`: @Access('editor', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'The new project. Required unless parentId is given.' })
  @ValidateIf((o: ScaffoldProjectDto) => !o.parentId)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: ScaffoldProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  description?: string | null;

  @ApiProperty({ enum: SUPPORTED_LOCALES, description: 'The language titles and skeletons are written in' })
  @IsIn(SUPPORTED_LOCALES, { message: vmsg('isIn') })
  locale!: Locale;

  @ApiPropertyOptional({ enum: BUILT_IN_BLUEPRINT_KEYS, description: 'A built-in blueprint. Exactly one of blueprintKey and blueprint.' })
  @IsOptional()
  @IsIn(BUILT_IN_BLUEPRINT_KEYS, { message: vmsg('isIn') })
  blueprintKey?: BuiltInBlueprintKey;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'An inline `Blueprint` (@knowledge/contracts), validated server-side. Exactly one of blueprintKey and blueprint.',
  })
  @IsOptional()
  @IsObject()
  blueprint?: Record<string, unknown>;

  @ApiPropertyOptional({ format: 'uuid', description: 'Scaffold under this page of its existing project; conventions are not written' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Restrict the new project before its first page is written; the creator is granted manage. Ignored with parentId.',
  })
  @IsOptional()
  @IsBoolean()
  restricted?: boolean;

  @ApiPropertyOptional({ type: String, description: "The new project's emoji face. Ignored with parentId." })
  @IsOptional()
  @IsString()
  @MaxLength(16, { message: vmsg('maxLength') })
  avatarEmoji?: string;

  @ApiPropertyOptional({ type: String, description: 'Hex colour behind the emoji, e.g. `#3b82f6`.' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: vmsg('hexColor') })
  avatarColor?: string;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  /** `null` clears the description; omitting the field leaves it untouched. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  description?: string | null;

  /**
   * An emoji to use instead of a picture. `null` clears it and falls back to
   * the monogram; setting one retires any uploaded picture, since a project has
   * one face.
   *
   * Capped generously rather than at 1: a single emoji can be several code
   * points (a skin tone, a ZWJ sequence), so counting characters would refuse
   * perfectly ordinary ones.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateProjectDto) => o.avatarEmoji !== null)
  @IsString()
  @MaxLength(16, { message: vmsg('maxLength') })
  avatarEmoji?: string | null;

  /** Hex colour behind the emoji, e.g. `#3b82f6`. Ignored without one. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateProjectDto) => o.avatarColor !== null)
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: vmsg('hexColor') })
  avatarColor?: string | null;
}

export class DeletionPreviewQueryDto {
  /**
   * The project the contents would move into. Optional because the destination
   * is chosen inside the dialog — without it the preview still answers "what is
   * in here", it just cannot yet name the glossary terms the move would drop,
   * which are a property of the pair rather than of this project.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Prospective destination project' })
  @IsOptional()
  @IsUUID()
  target?: string;
}

export class DeleteProjectQueryDto {
  /**
   * What happens to the contents. `move` (the default) reassigns them to
   * `moveContentsTo`; `cascade` destroys them, and is the only operation in the
   * product that deletes a page.
   */
  @ApiPropertyOptional({ enum: PROJECT_DELETION_MODES, description: 'Defaults to move' })
  @IsOptional()
  @IsIn(PROJECT_DELETION_MODES, { message: vmsg('isIn') })
  mode?: ProjectDeletionMode;

  /**
   * Where this project's contents go. Required by `mode=move` whenever the
   * project holds anything at all: documents are never deleted in this product,
   * so removal is move-then-delete and the destination is the whole decision.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Sibling project to move contents into' })
  @IsOptional()
  @IsUUID()
  moveContentsTo?: string;

  /**
   * The project's own name, echoed back. Required by `mode=cascade` and
   * checked server-side: an irreversible act should not be confirmable only by
   * the client that asked for it.
   */
  @ApiPropertyOptional({ description: 'Required for mode=cascade: the project name, verbatim' })
  @IsOptional()
  @IsString()
  confirm?: string;
}
