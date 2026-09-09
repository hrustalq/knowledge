import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts';
import { vmsg } from '../../common/validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CreateImportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid', description: 'Project the imported page will belong to' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'Original filename — its extension chooses the parser' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255, { message: vmsg('maxLength') })
  filename!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiProperty({ description: 'Claimed size; re-checked against the bucket before parsing' })
  @IsInt()
  @IsPositive()
  sizeBytes!: number;

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES, description: 'Feature 07 categorization; defaults to "other"' })
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[])
  category?: DocumentCategory;

  @ApiPropertyOptional({ format: 'uuid', description: 'Feature 08 nesting: import under this page' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class SubmitImportDto {
  @ApiProperty({ description: 'Title as reviewed — becomes documents.title' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300, { message: vmsg('maxLength') })
  title!: string;

  @ApiProperty({ description: 'Markdown as reviewed and edited; this is what the page is created from' })
  @IsString()
  markdown!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Overrides the destination chosen before parsing' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES, description: 'Overrides the category chosen before parsing' })
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[])
  category?: DocumentCategory;

  /**
   * Explicit null re-roots the page, mirroring `UpdateDocumentDto.parentId`:
   * absent means "keep what step 1 chose", null means "no parent".
   */
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((o: SubmitImportDto) => o.parentId !== undefined && o.parentId !== null)
  @Matches(UUID_RE, { message: 'parentId must be a UUID' })
  parentId?: string | null;
}
