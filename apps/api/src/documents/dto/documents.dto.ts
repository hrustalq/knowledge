import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts';
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { vmsg } from '../../common/validation.js';

export class InlineContentDto {
  @ApiProperty({ enum: ['inline'] })
  @IsIn(['inline'])
  mode!: 'inline';

  @ApiProperty({ example: 'markdown' })
  @IsString()
  @IsNotEmpty()
  format!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  text!: string;
}

export const RELATION_TYPES = [
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
] as const;

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
  @ApiProperty({ enum: RELATION_TYPES })
  @IsIn(RELATION_TYPES as unknown as string[])
  type!: string;

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

export class AddRelationsDto {
  @ApiProperty({ type: [RelationInputDto] })
  @IsArray()
  @ArrayMaxSize(100, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RelationInputDto)
  relations!: RelationInputDto[];
}
