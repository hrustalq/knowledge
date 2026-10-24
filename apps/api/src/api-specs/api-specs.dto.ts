import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
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
  API_TEST_RUNNER_MODES,
  API_TEST_SUITE_FORMATS,
  API_TRY_PROXY_MODES,
  CODE_SAMPLE_LANGS,
  type ApiBreakingChangePolicy,
  type ApiTestRunnerMode,
  type ApiTestSuiteFormat,
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

  @ApiPropertyOptional({
    enum: API_TEST_RUNNER_MODES,
    nullable: true,
    type: String,
    description: 'The QA server runner (#483); on applies only when API_TEST_RUNNER_MODE is on. null is off',
  })
  @IsOptional()
  @IsIn(API_TEST_RUNNER_MODES)
  apiTestRunner?: ApiTestRunnerMode | null;
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

export class ApiTestSuiteQueryDto {
  @ApiProperty({ description: 'The operation, as its row names it (op:billing-api:post-/invoices)' })
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey!: string;

  @ApiPropertyOptional({
    enum: API_TEST_SUITE_FORMATS,
    description: 'Answer with a file instead of JSON: one curl command per case, or a Postman Collection v2.1',
  })
  @IsOptional()
  @IsIn(API_TEST_SUITE_FORMATS)
  format?: ApiTestSuiteFormat;
}

export class GenerateApiTestSuiteDto {
  @ApiProperty({ description: 'The operation, as its row names it (op:billing-api:post-/invoices)' })
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey!: string;

  @ApiPropertyOptional({ description: 'Replace the cached suite instead of returning it. Absent means false.' })
  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}

/** One operation's suite (#483): the bindings and candidate reads, and Ask tester. */
export class ApiTestOperationDto {
  @ApiProperty({ description: 'The operation, as its row names it (op:billing-api:post-/invoices)' })
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey!: string;
}

export class ApiTestBindingDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'A case id of the suite; absent or null binds the whole suite' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  caseId?: string | null;

  @ApiProperty({ format: 'uuid', description: 'A test-fixture document' })
  @IsUUID()
  fixtureId!: string;
}

export class SetApiTestBindingsDto extends ApiTestOperationDto {
  @ApiProperty({ type: [ApiTestBindingDto], description: 'Every binding of the suite, in run order; replaces what is there. Empty unbinds all' })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApiTestBindingDto)
  bindings!: ApiTestBindingDto[];
}

export class ListTestFixturesQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only the fixtures of this project' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Only the fixtures whose head calls this operation, however the key is spelled' })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only the fixtures calling an operation this spec document defines' })
  @IsOptional()
  @IsUUID()
  specDocumentId?: string;
}

export class QaOverviewQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: "Only this project's specs" })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: "Only this spec document's operations" })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

export class RunApiTestSuiteDto {
  @ApiProperty({ description: 'The operation, as its row names it (op:billing-api:post-/invoices)' })
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  entityKey!: string;

  @ApiProperty({ format: 'uuid', description: 'The test environment whose server and values the run uses' })
  @IsUUID()
  environmentId!: string;
}

export class SaveApiTestEnvironmentDto {
  @ApiPropertyOptional({ description: 'Unique in the workspace; required to create' })
  @IsOptional()
  @IsString()
  @MaxLength(80, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "An http(s) base URL; a step uses it when the step's spec declares it in servers",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  server?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' }, description: 'Non-secret values by plan name (input.currency); replaces the set' })
  @IsOptional()
  @IsObject()
  inputs?: Record<string, string>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description: 'Secrets by plan name (secret.qaPassword, TOKEN): a string sets or replaces, null removes. Never returned',
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string | null>;
}
