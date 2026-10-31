import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { SOURCE_INTERVALS_MIN } from '@knowledge/contracts';

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
}

/** PATCH /v1/documents/:id/source */
export class UpdateDocumentSourceDto {
  @ApiProperty({ type: Number, nullable: true, enum: SOURCE_INTERVALS_MIN, description: 'Minutes between checks; null = only on demand' })
  @ValidateIf((_o, v) => v !== null)
  @IsIn([...SOURCE_INTERVALS_MIN])
  intervalMinutes!: number | null;
}

/** POST /v1/documents/:id/source/restore */
export class RestoreDocumentSourceDto {
  @ApiProperty({ format: 'uuid', description: 'An earlier revision of this page' })
  @IsUUID()
  revisionId!: string;
}
