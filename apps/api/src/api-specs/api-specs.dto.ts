import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { vmsg } from '../common/validation.js';

export class ListApiSpecsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only the specs of this project' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class ApiSpecRevisionQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'A revision of this document; the default-branch head when absent' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;
}

export class SearchApiOperationsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Matches method + path, summary, operationId and entity key, case-insensitively' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  q?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only the operations of this spec document' })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'Defaults to 50' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(200, { message: vmsg('max') })
  limit?: number;
}
