import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AUTHORABLE_RELATION_TYPES,
  DOCUMENT_CATEGORIES,
  type AuthorableRelationType,
  type DocumentCategory,
} from '@knowledge/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { vmsg } from '../../common/validation.js';

/** Ceiling on an inline document body — see the note on InlineContentDto.text. */
const MAX_INLINE_TEXT_CHARS = 500_000;

export class InlineContentDto {
  @ApiProperty({ enum: ['inline'] })
  @IsIn(['inline'])
  mode!: 'inline';

  @ApiProperty({ example: 'markdown' })
  @IsString()
  @IsNotEmpty()
  format!: string;

  /**
   * A very long page. Bounded so oversize is a translated VALIDATION_FAILED
   * rather than an untranslated 500 from body-parser; HTTP_BODY_LIMIT sits
   * above this (in bytes, which is not the same unit — see env.ts).
   */
  @ApiProperty({ maxLength: MAX_INLINE_TEXT_CHARS })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_INLINE_TEXT_CHARS, { message: vmsg('maxLength') })
  text!: string;
}

export class RelationTargetDto {
  @ApiProperty({ example: 'service' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: 'service:identity' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiPropertyOptional({ example: 'Identity Service' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class RelationInputDto {
  /** `@IsIn` already guarantees this at runtime; the type says so too. */
  @ApiProperty({ enum: AUTHORABLE_RELATION_TYPES })
  @IsIn(AUTHORABLE_RELATION_TYPES as unknown as string[])
  type!: AuthorableRelationType;

  @ApiProperty({ type: RelationTargetDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RelationTargetDto)
  target!: RelationTargetDto;
}

export class CreateDocumentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid', description: 'Owning project; must belong to workspaceId' })
  @IsUUID()
  projectId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({ type: InlineContentDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InlineContentDto)
  content?: InlineContentDto;

  @ApiPropertyOptional({ type: [RelationInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RelationInputDto)
  relations?: RelationInputDto[];

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES, default: 'other', description: 'Feature 07 categorization' })
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[])
  category?: DocumentCategory;

  @ApiPropertyOptional({ format: 'uuid', description: 'Feature 08 nesting: create under this document' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES })
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[])
  category?: DocumentCategory;

  /** Explicit null re-roots the document (feature 08). */
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @ValidateIf((o: UpdateDocumentDto) => o.parentId !== undefined && o.parentId !== null)
  @IsUUID()
  parentId?: string | null;

  /**
   * Move to another project in the same workspace. The document's whole
   * subtree moves with it; unless `parentId` is given in the same call the
   * document is re-rooted, because its old parent stays behind.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class CreateUploadDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;

  @ApiProperty({ example: 'text/markdown' })
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiProperty({ example: 'source.md' })
  @IsString()
  @IsNotEmpty()
  filename!: string;
}

export class CreateRevisionDto {
  @ApiPropertyOptional({ default: 'main' })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({ example: 'text/markdown' })
  @IsOptional()
  @IsString()
  contentType?: string;
}

export class CreateBranchDto {
  @ApiProperty({ example: 'feature/oauth' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the default-branch head' })
  @IsOptional()
  @IsUUID()
  fromRevisionId?: string;
}

export class CurateRelationDto {
  @ApiProperty({ type: () => RelationInputDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RelationInputDto)
  relation!: RelationInputDto;
}

export class RelationRefDto {
  @ApiProperty({ enum: AUTHORABLE_RELATION_TYPES })
  @IsIn(AUTHORABLE_RELATION_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({ example: 'service:identity' })
  @IsString()
  @IsNotEmpty()
  targetKey!: string;
}

/**
 * A change to the page's frontmatter relations, proposed as a merge request
 * (docs/features/28). `add` + `remove` in one call covers update; `tags`
 * replaces the whole list when present and leaves it alone when absent.
 */
export class ProposeRelationsDto {
  @ApiPropertyOptional({ type: [RelationInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RelationInputDto)
  add?: RelationInputDto[];

  @ApiPropertyOptional({ type: [RelationRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RelationRefDto)
  remove?: RelationRefDto[];

  @ApiPropertyOptional({ type: String, isArray: true, description: 'Replaces the whole tag list' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Merge request title; defaulted when absent' })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  title?: string;

  @ApiPropertyOptional({ description: 'Why the change is being proposed' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  description?: string;
}

export class AddRelationsDto {
  @ApiProperty({ type: [RelationInputDto] })
  @IsArray()
  @ArrayMaxSize(100, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RelationInputDto)
  relations!: RelationInputDto[];
}
