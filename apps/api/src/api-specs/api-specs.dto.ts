import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  API_BREAKING_CHANGE_POLICIES,
  API_TRY_PROXY_MODES,
  CODE_SAMPLE_LANGS,
  type ApiBreakingChangePolicy,
  type ApiTryProxyMode,
  type CodeSampleLang,
} from '@knowledge/contracts';
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

  @ApiPropertyOptional({
    description: 'Exactly this operation, however the key is spelled (op:billing-api:post-/invoices) — resolves a link to its spec',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'Defaults to 50' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(200, { message: vmsg('max') })
  limit?: number;
}

export class ApiSamplesQueryDto {
  @ApiProperty({ description: 'The operation, as its row names it (op:billing-api:post-/invoices)' })
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey!: string;

  @ApiPropertyOptional({ description: 'The method, when one key has several rows' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: vmsg('maxLength') })
  method?: string;

  @ApiPropertyOptional({ enum: CODE_SAMPLE_LANGS, description: 'One language; every language when absent' })
  @IsOptional()
  @IsIn(CODE_SAMPLE_LANGS)
  lang?: CodeSampleLang;

  @ApiPropertyOptional({ format: 'uuid', description: 'A revision of this document; the default-branch head when absent' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;
}

export class ApiTryHeaderDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(8000, { message: vmsg('maxLength') })
  value!: string;
}

export class ApiTryRequestDto {
  @ApiProperty({ format: 'uuid', description: 'The revision being viewed: the target must be one of its servers' })
  @IsUUID()
  revisionId!: string;

  @ApiProperty({ description: 'The operation tried; the URL path must be its path' })
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey!: string;

  @ApiProperty({ example: 'GET' })
  @IsString()
  @MaxLength(20, { message: vmsg('maxLength') })
  method!: string;

  @ApiProperty({ description: 'The full URL, query included' })
  @IsString()
  @MaxLength(8000, { message: vmsg('maxLength') })
  url!: string;

  @ApiPropertyOptional({ type: [ApiTryHeaderDto], description: 'Sent per request; never stored or logged' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApiTryHeaderDto)
  headers?: ApiTryHeaderDto[];

  @ApiPropertyOptional({ type: String, nullable: true, description: 'At most 256 KB' })
  @IsOptional()
  @IsString()
  body?: string | null;
}

export class UpdateApiSettingsDto {
  @ApiPropertyOptional({ enum: API_TRY_PROXY_MODES, nullable: true, type: String, description: 'null inherits API_TRY_PROXY_MODE' })
  @IsOptional()
  @IsIn(API_TRY_PROXY_MODES)
  apiTryProxyMode?: ApiTryProxyMode | null;

  @ApiPropertyOptional({
    enum: API_BREAKING_CHANGE_POLICIES,
    nullable: true,
    type: String,
    description: 'The merge gate for breaking spec changes; null inherits warn',
  })
  @IsOptional()
  @IsIn(API_BREAKING_CHANGE_POLICIES)
  apiBreakingChangePolicy?: ApiBreakingChangePolicy | null;
}

export class ApiSpecDiffQueryDto {
  @ApiProperty({ format: 'uuid', description: 'The revision diffed from' })
  @IsUUID()
  from!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The revision diffed to; the default-branch head when absent' })
  @IsOptional()
  @IsUUID()
  to?: string;
}
