import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Request DTOs for the AI settings surface (docs/features/12).
 *
 * Nullable fields carry an explicit `type:` — without it openapi-typescript
 * emits `Record<string, never>` and the web typecheck breaks at every call
 * site that passes a real value (CLAUDE.md). And `null` is load-bearing here:
 * it means "drop the override and inherit the env value again", so
 * `@ValidateIf(o => o.x !== null)` keeps `undefined` (absent) and `null`
 * (clear) distinguishable, exactly as UpdateMergeRequestDto.assigneeId does.
 */

const NULLABLE = <T extends object>(field: keyof T) => ValidateIf((o: T) => o[field] !== null);

export class UpdateAiSettingsDto {
  // Field name must stay `workspaceId`: @Access('admin', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ enum: ['none', 'openai-compatible', 'deepseek'], type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('provider')
  @IsIn(['none', 'openai-compatible', 'deepseek'])
  provider?: 'none' | 'openai-compatible' | 'deepseek' | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://api.deepseek.com' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('baseUrl')
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'deepseek-chat' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('model')
  @IsString()
  @MaxLength(200)
  model?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Write-only. Omit to keep the stored key; null or "" clears it and falls back to ASSISTANT_API_KEY.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('apiKey')
  @IsString()
  @MaxLength(500)
  apiKey?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 2 })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('temperature')
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 16 })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('maxToolCalls')
  @IsInt()
  @Min(0)
  @Max(16)
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1000, maximum: 600_000 })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('timeoutMs')
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  timeoutMs?: number | null;

  @ApiPropertyOptional({ description: 'Allow Agent mode (write tools) in the chat for this workspace' })
  @IsOptional()
  @IsBoolean()
  agentModeEnabled?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M prompt tokens (cost estimate)' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('pricePromptPerMTok')
  @IsNumber()
  @Min(0)
  pricePromptPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M completion tokens (cost estimate)' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('priceCompletionPerMTok')
  @IsNumber()
  @Min(0)
  priceCompletionPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Monthly workspace token budget; null = unlimited' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('workspaceMonthlyTokenBudget')
  @IsInt()
  @Min(0)
  workspaceMonthlyTokenBudget?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Default per-user monthly budget; null = unlimited' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('defaultUserMonthlyTokenBudget')
  @IsInt()
  @Min(0)
  defaultUserMonthlyTokenBudget?: number | null;

  @ApiPropertyOptional({ description: 'Refuse assistant requests once a budget is spent (429)' })
  @IsOptional()
  @IsBoolean()
  enforceBudget?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Provider profile serving chat and agent turns' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('chatProviderId')
  @IsUUID()
  chatProviderId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Provider profile serving draft review and suggestions' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('reviewProviderId')
  @IsUUID()
  reviewProviderId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Provider profile serving the worker\'s relation extraction' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('extractionProviderId')
  @IsUUID()
  extractionProviderId?: string | null;
}

export class TestAiConnectionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Test one profile instead of whatever chat is routed at' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}

// ---- Provider profiles -----------------------------------------------------

export class CreateAiProviderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'DeepSeek prod' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: ['openai-compatible', 'deepseek'] })
  @IsIn(['openai-compatible', 'deepseek'])
  provider!: 'openai-compatible' | 'deepseek';

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://api.deepseek.com' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('baseUrl')
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @ApiProperty({ example: 'deepseek-chat' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only credential; null clears it' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('apiKey')
  @IsString()
  @MaxLength(500)
  apiKey?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 2 })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('temperature')
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 16 })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('maxToolCalls')
  @IsInt()
  @Min(0)
  @Max(16)
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1000, maximum: 600_000 })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('timeoutMs')
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  timeoutMs?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M prompt tokens' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('pricePromptPerMTok')
  @IsNumber()
  @Min(0)
  pricePromptPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M completion tokens' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('priceCompletionPerMTok')
  @IsNumber()
  @Min(0)
  priceCompletionPerMTok?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: ['openai-compatible', 'deepseek'] })
  @IsOptional()
  @IsIn(['openai-compatible', 'deepseek'])
  provider?: 'openai-compatible' | 'deepseek';

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('baseUrl')
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only; omit to keep, null to clear' })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('apiKey')
  @IsString()
  @MaxLength(500)
  apiKey?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('temperature')
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('maxToolCalls')
  @IsInt()
  @Min(0)
  @Max(16)
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('timeoutMs')
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  timeoutMs?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('pricePromptPerMTok')
  @IsNumber()
  @Min(0)
  pricePromptPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('priceCompletionPerMTok')
  @IsNumber()
  @Min(0)
  priceCompletionPerMTok?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

// ---- Skills ----------------------------------------------------------------

export class CreateAiSkillDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'Release notes writer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'Draft release notes from merged merge requests' })
  @IsString()
  @MaxLength(500)
  description!: string;

  @ApiProperty({ description: 'Markdown instructions merged into the system prompt', maxLength: 8000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  instructions!: string;

  @ApiPropertyOptional({ type: [String], description: 'Keywords that pull this skill into a turn' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  triggers?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiSkillDto {
  @ApiPropertyOptional({ example: 'Release notes writer' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ maxLength: 8000 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  instructions?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  triggers?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

// ---- Plugins ---------------------------------------------------------------

export class CreateAiPluginDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'Jira' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: ['streamable-http', 'sse'], default: 'streamable-http' })
  @IsOptional()
  @IsIn(['streamable-http', 'sse'])
  transport?: 'streamable-http' | 'sse';

  @ApiProperty({ example: 'https://mcp.example.com/jira' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  url!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Authorization' })
  @IsOptional()
  @NULLABLE<CreateAiPluginDto>('authHeader')
  @IsString()
  @MaxLength(120)
  authHeader?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only credential; null clears it' })
  @IsOptional()
  @NULLABLE<CreateAiPluginDto>('authValue')
  @IsString()
  @MaxLength(2_000)
  authValue?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Tools offered to the model; empty = every discovered tool' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  enabledTools?: string[];
}

export class UpdateAiPluginDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: ['streamable-http', 'sse'] })
  @IsOptional()
  @IsIn(['streamable-http', 'sse'])
  transport?: 'streamable-http' | 'sse';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiPluginDto>('authHeader')
  @IsString()
  @MaxLength(120)
  authHeader?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only; omit to keep, null to clear' })
  @IsOptional()
  @NULLABLE<UpdateAiPluginDto>('authValue')
  @IsString()
  @MaxLength(2_000)
  authValue?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  enabledTools?: string[];
}

// ---- Budgets ---------------------------------------------------------------

export class SetAiBudgetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Monthly token budget; null = unlimited' })
  @IsOptional()
  @NULLABLE<SetAiBudgetDto>('monthlyTokenBudget')
  @IsInt()
  @Min(0)
  monthlyTokenBudget?: number | null;
}
