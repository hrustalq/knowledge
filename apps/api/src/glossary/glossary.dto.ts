import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { vmsg } from '../common/validation.js';

/** Mirrors UUID_RE in acl.guard.ts (any version digit, nil allowed). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A term is a linking key, not prose: the linker scans every rendered page for
 * it, so an entire sentence as a "term" would be both useless and expensive.
 */
const MAX_TERM_CHARS = 80;
const MAX_DEFINITION_CHARS = 2_000;

export class ListGlossaryQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Restrict to one project; absent = every project in the workspace' })
  @IsOptional()
  @Matches(UUID_RE)
  projectId?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive substring match on term, aliases or definition' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class CreateGlossaryTermDto {
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ description: 'Project the term belongs to (must be in the same workspace)' })
  @IsString()
  @Matches(UUID_RE)
  projectId!: string;

  @ApiProperty({ example: 'Merge base' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TERM_CHARS, { message: vmsg('maxLength') })
  term!: string;

  @ApiProperty({ example: 'The nearest common ancestor of two revisions in the DAG.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DEFINITION_CHARS, { message: vmsg('maxLength') })
  definition!: string;

  @ApiPropertyOptional({ type: [String], description: 'Abbreviations and inflections that link to this entry' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  @MaxLength(MAX_TERM_CHARS, { each: true, message: vmsg('maxLength') })
  aliases?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Page that defines the term in full' })
  @IsOptional()
  @ValidateIf((o: CreateGlossaryTermDto) => o.documentId !== null)
  @Matches(UUID_RE)
  documentId?: string | null;

  // No `default:` in either decorator on purpose: openapi-typescript promotes
  // a property that declares a default to *required* in the generated client,
  // which would force every call site to pass a value the server already fills.
  @ApiPropertyOptional({ enum: ['manual', 'ai'], description: 'Defaults to "manual"' })
  @IsOptional()
  @IsIn(['manual', 'ai'])
  source?: 'manual' | 'ai';

  @ApiPropertyOptional({ description: 'Defaults to true' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateGlossaryTermDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TERM_CHARS, { message: vmsg('maxLength') })
  term?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DEFINITION_CHARS, { message: vmsg('maxLength') })
  definition?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  @MaxLength(MAX_TERM_CHARS, { each: true, message: vmsg('maxLength') })
  aliases?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, description: 'null unlinks the defining page' })
  @IsOptional()
  @ValidateIf((o: UpdateGlossaryTermDto) => o.documentId !== null)
  @Matches(UUID_RE)
  documentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SuggestGlossaryTermsDto {
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Read the head revision of this page (mutually exclusive with markdown)' })
  @IsOptional()
  @Matches(UUID_RE)
  documentId?: string;

  @ApiPropertyOptional({
    description: "Project whose glossary to check against; defaults to the source document's own project",
  })
  @IsOptional()
  @Matches(UUID_RE)
  projectId?: string;

  @ApiPropertyOptional({ description: 'Raw draft text — lets the editor suggest against unsaved content' })
  @IsOptional()
  @IsString()
  markdown?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;
}
