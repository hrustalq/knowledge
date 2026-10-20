import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { EXPORT_FORMATS, type ExportFormat } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** Exports (docs/features/45). */
export class CreateProjectExportDto {
  @ApiProperty({ enum: EXPORT_FORMATS, description: '`zip`: markdown + attachments + manifest.json; `html`: an offline site, zipped; `pdf`: needs GOTENBERG_URL; `docx`: one Word document' })
  @IsIn(EXPORT_FORMATS)
  format!: ExportFormat;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 100,
    description: 'Branch name to read each page from; a page without it uses its default branch. Omitted or null: default branches',
  })
  @ValidateIf((o: CreateProjectExportDto) => o.branch !== undefined && o.branch !== null)
  @IsString()
  @MaxLength(100, { message: vmsg('maxLength') })
  branch?: string | null;
}

export class CreateDocumentExportDto extends CreateProjectExportDto {
  @ApiPropertyOptional({ description: 'Also export every page under this one. Omitted: false' })
  @IsOptional()
  @IsBoolean()
  includeSubtree?: boolean;
}
