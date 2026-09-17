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
import {
  AGENT_CAPABILITIES,
  AGENT_SURFACES,
  WEB_ACCESS_MODES,
  type AgentCapability,
  type AgentSurface,
  type WebAccessMode,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

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

  @ApiPropertyOptional({ enum: ['none', 'openai-compatible', 'deepseek', 'gen-api'], type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('provider')
  @IsIn(['none', 'openai-compatible', 'deepseek', 'gen-api'])
  provider?: 'none' | 'openai-compatible' | 'deepseek' | 'gen-api' | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://api.deepseek.com' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('baseUrl')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  baseUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'deepseek-chat' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('model')
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  model?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Write-only. Omit to keep the stored key; null or "" clears it and falls back to ASSISTANT_API_KEY.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('apiKey')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  apiKey?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 2 })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('temperature')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(2, { message: vmsg('max') })
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 64 })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('maxToolCalls')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  // 64, matching ASSISTANT_MAX_TOOL_CALLS' ceiling in env.ts. At 16 a workspace
  // could not raise its own override to the value the env default now uses.
  @Max(64, { message: vmsg('max') })
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1000, maximum: 600_000 })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('timeoutMs')
  @IsInt()
  @Min(1_000, { message: vmsg('min') })
  @Max(600_000, { message: vmsg('max') })
  timeoutMs?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1,
    description: 'Relations scoring below this are discarded. Null inherits EXTRACTOR_MIN_CONFIDENCE (0.5).',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('extractionMinConfidence')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(1, { message: vmsg('max') })
  extractionMinConfidence?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 200,
    description: 'Chunks of a page sent to the extractor. Null inherits EXTRACTOR_MAX_CHUNKS (20).',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('extractionMaxChunks')
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(200, { message: vmsg('max') })
  extractionMaxChunks?: number | null;

  @ApiPropertyOptional({ description: 'Allow Agent mode (write tools) in the chat for this workspace' })
  @IsOptional()
  @IsBoolean()
  agentModeEnabled?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M prompt tokens (cost estimate)' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('pricePromptPerMTok')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  pricePromptPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M completion tokens (cost estimate)' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('priceCompletionPerMTok')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  priceCompletionPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Monthly workspace token budget; null = unlimited' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('workspaceMonthlyTokenBudget')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  workspaceMonthlyTokenBudget?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Default per-user monthly budget; null = unlimited' })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('defaultUserMonthlyTokenBudget')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  defaultUserMonthlyTokenBudget?: number | null;

  @ApiPropertyOptional({ description: 'Refuse assistant requests once a budget is spent (429)' })
  @IsOptional()
  @IsBoolean()
  enforceBudget?: boolean;

  @ApiPropertyOptional({
    enum: WEB_ACCESS_MODES,
    type: String,
    nullable: true,
    description:
      'How much of the open web the assistant may reach. Clamped by the WEB_ACCESS_MODE ceiling — ' +
      'a value wider than the ceiling is accepted and stored, but the effective mode stays the ' +
      'ceiling and the response reports source=clamped. null = inherit the ceiling.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('webAccessMode')
  @IsIn(WEB_ACCESS_MODES)
  webAccessMode?: WebAccessMode | null;

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
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ enum: ['openai-compatible', 'deepseek', 'gen-api'] })
  @IsIn(['openai-compatible', 'deepseek', 'gen-api'])
  provider!: 'openai-compatible' | 'deepseek' | 'gen-api';

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://api.deepseek.com' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('baseUrl')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  baseUrl?: string | null;

  @ApiProperty({ example: 'deepseek-chat' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  model!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only credential; null clears it' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('apiKey')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  apiKey?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 2 })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('temperature')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(2, { message: vmsg('max') })
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 64 })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('maxToolCalls')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  // 64, matching ASSISTANT_MAX_TOOL_CALLS' ceiling in env.ts. At 16 a workspace
  // could not raise its own override to the value the env default now uses.
  @Max(64, { message: vmsg('max') })
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1000, maximum: 600_000 })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('timeoutMs')
  @IsInt()
  @Min(1_000, { message: vmsg('min') })
  @Max(600_000, { message: vmsg('max') })
  timeoutMs?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M prompt tokens' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('pricePromptPerMTok')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  pricePromptPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'USD per 1M completion tokens' })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('priceCompletionPerMTok')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  priceCompletionPerMTok?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [String],
    enum: AGENT_CAPABILITIES,
    nullable: true,
    description:
      'What this model can do, overriding the built-in model table. Null returns to the table (docs/features/20).',
  })
  @IsOptional()
  @NULLABLE<CreateAiProviderDto>('capabilities')
  @IsArray()
  @ArrayMaxSize(8, { message: vmsg('arrayMaxSize') })
  @IsIn(AGENT_CAPABILITIES as unknown as string[], { each: true, message: vmsg('isIn') })
  capabilities?: AgentCapability[] | null;

}

export class UpdateAiProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ enum: ['openai-compatible', 'deepseek', 'gen-api'] })
  @IsOptional()
  @IsIn(['openai-compatible', 'deepseek', 'gen-api'])
  provider?: 'openai-compatible' | 'deepseek' | 'gen-api';

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('baseUrl')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  baseUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  model?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only; omit to keep, null to clear' })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('apiKey')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  apiKey?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('temperature')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(2, { message: vmsg('max') })
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('maxToolCalls')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  // 64, matching ASSISTANT_MAX_TOOL_CALLS' ceiling in env.ts. At 16 a workspace
  // could not raise its own override to the value the env default now uses.
  @Max(64, { message: vmsg('max') })
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('timeoutMs')
  @IsInt()
  @Min(1_000, { message: vmsg('min') })
  @Max(600_000, { message: vmsg('max') })
  timeoutMs?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('pricePromptPerMTok')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  pricePromptPerMTok?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('priceCompletionPerMTok')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  priceCompletionPerMTok?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [String],
    enum: AGENT_CAPABILITIES,
    nullable: true,
    description:
      'What this model can do, overriding the built-in model table. Null returns to the table (docs/features/20).',
  })
  @IsOptional()
  @NULLABLE<UpdateAiProviderDto>('capabilities')
  @IsArray()
  @ArrayMaxSize(8, { message: vmsg('arrayMaxSize') })
  @IsIn(AGENT_CAPABILITIES as unknown as string[], { each: true, message: vmsg('isIn') })
  capabilities?: AgentCapability[] | null;

}

// ---- Skills ----------------------------------------------------------------

export class CreateAiSkillDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'Release notes writer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ example: 'Draft release notes from merged merge requests' })
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  description!: string;

  @ApiProperty({ description: 'Markdown instructions merged into the system prompt', maxLength: 8000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000, { message: vmsg('maxLength') })
  instructions!: string;

  @ApiPropertyOptional({ type: [String], description: 'Keywords that pull this skill into a turn' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
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
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  description?: string;

  @ApiPropertyOptional({ maxLength: 8000 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000, { message: vmsg('maxLength') })
  instructions?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
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
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiPropertyOptional({ enum: ['streamable-http', 'sse'], default: 'streamable-http' })
  @IsOptional()
  @IsIn(['streamable-http', 'sse'])
  transport?: 'streamable-http' | 'sse';

  @ApiProperty({ example: 'https://mcp.example.com/jira' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500, { message: vmsg('maxLength') })
  url!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Authorization' })
  @IsOptional()
  @NULLABLE<CreateAiPluginDto>('authHeader')
  @IsString()
  @MaxLength(120, { message: vmsg('maxLength') })
  authHeader?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only credential; null clears it' })
  @IsOptional()
  @NULLABLE<CreateAiPluginDto>('authValue')
  @IsString()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  authValue?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Tools offered to the model; empty = every discovered tool' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  enabledTools?: string[];
}

export class UpdateAiPluginDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ enum: ['streamable-http', 'sse'] })
  @IsOptional()
  @IsIn(['streamable-http', 'sse'])
  transport?: 'streamable-http' | 'sse';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500, { message: vmsg('maxLength') })
  url?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiPluginDto>('authHeader')
  @IsString()
  @MaxLength(120, { message: vmsg('maxLength') })
  authHeader?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only; omit to keep, null to clear' })
  @IsOptional()
  @NULLABLE<UpdateAiPluginDto>('authValue')
  @IsString()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  authValue?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200, { message: vmsg('arrayMaxSize') })
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
  @Min(0, { message: vmsg('min') })
  monthlyTokenBudget?: number | null;
}

// ---- Agents (docs/features/20) ---------------------------------------------

/**
 * Every field is an override: absent leaves it alone, `null` clears it back to
 * the built-in's code default. That is why each one is @NULLABLE rather than
 * merely @IsOptional — "reset this field" and "don't touch this field" have to
 * stay distinguishable on the wire (the UpdateMergeRequestDto.assigneeId
 * precedent).
 */
export class UpdateAiAgentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Reviewer' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('name')
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('description')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'System prompt. Null restores the shipped default.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('instructions')
  @IsString()
  @MaxLength(16_000, { message: vmsg('maxLength') })
  instructions?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true, description: 'Tool names this agent may call.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('tools')
  @IsArray()
  @ArrayMaxSize(40, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  tools?: string[] | null;

  @ApiPropertyOptional({ type: [String], nullable: true, description: 'Skills always attached to this agent.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('skillIds')
  @IsArray()
  @ArrayMaxSize(10, { message: vmsg('arrayMaxSize') })
  @IsUUID('4', { each: true })
  skillIds?: string[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'Provider profile. Null follows the workspace route.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('providerId')
  @IsUUID()
  providerId?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('temperature')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(2, { message: vmsg('max') })
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('maxToolCalls')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  // Was 50 while every sibling DTO said 16 — an inconsistency that predates
  // this change. All four now agree with env.ts.
  @Max(64, { message: vmsg('max') })
  maxToolCalls?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('timeoutMs')
  @IsInt()
  @Min(1_000, { message: vmsg('min') })
  @Max(600_000, { message: vmsg('max') })
  timeoutMs?: number | null;

  @ApiPropertyOptional({ description: 'Run this agent on a schedule. Defaults to false.' })
  @IsOptional()
  @IsBoolean()
  scheduleEnabled?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Minutes between scheduled runs.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('scheduleMinutes')
  @IsInt()
  @Min(15, { message: vmsg('min') })
  @Max(20_160, { message: vmsg('max') })
  scheduleMinutes?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Instruction seeded into every scheduled run.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('scheduleNote')
  @IsString()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  scheduleNote?: string | null;

  // Not nullable: `enabled` is a real column with its own default, not an
  // inherited field. Describing the default in prose rather than declaring
  // `default:` keeps openapi-typescript from making it required (CLAUDE.md).
  @ApiPropertyOptional({ description: 'Defaults to true.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** A workspace's own agent, alongside the built-in roster. */
export class CreateAiAgentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'release-notes', description: 'Slug, unique in the workspace. Cannot shadow a built-in.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60, { message: vmsg('maxLength') })
  key!: string;

  @ApiProperty({ example: 'Release notes writer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ example: 'Drafts release notes from merged merge requests' })
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  description!: string;

  @ApiProperty({ maxLength: 16_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16_000, { message: vmsg('maxLength') })
  instructions!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  tools?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: vmsg('arrayMaxSize') })
  @IsUUID('4', { each: true })
  skillIds?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @NULLABLE<CreateAiAgentDto>('providerId')
  @IsUUID()
  providerId?: string | null;
}

/** Ask the router what it would do, without running the agent it picks. */
export class RouteAgentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'The request to classify. Omitted, the router answers from rules alone.' })
  @IsOptional()
  @IsString()
  @MaxLength(4_000, { message: vmsg('maxLength') })
  request?: string;

  @ApiPropertyOptional({ enum: AGENT_SURFACES, description: 'Restrict candidates to agents that run here.' })
  @IsOptional()
  @IsIn(AGENT_SURFACES as unknown as string[], { message: vmsg('isIn') })
  surface?: AgentSurface;

  @ApiPropertyOptional({ description: 'Skip classification and report this agent instead.' })
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: vmsg('maxLength') })
  agentKey?: string;
}

/** Start a background run of an agent, as the calling user. */
export class StartAgentRunDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Extra instruction seeded into this run only.' })
  @IsOptional()
  @IsString()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  note?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The repository connector a connector-scoped agent (the archaeologist) reads. Required when the ' +
      'workspace has more than one; the only one is used otherwise.',
  })
  @IsOptional()
  @IsUUID()
  connectorId?: string;
}

// ---- Source policies (docs/features/25) ------------------------------------

/**
 * One exception to the workspace's web access mode.
 *
 * `pattern` is validated loosely on purpose: `SourcePolicyService.normalizePattern`
 * accepts what an admin actually types — a full URL, a `*.example.com` glob —
 * and reduces it to the bare host, rather than answering a paste with a format
 * lecture. What it cannot reduce, it refuses there with the offending value in
 * the message.
 */
export class CreateSourcePolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'docs.example.com', description: 'Host pattern; a bare domain also covers its subdomains' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253, { message: vmsg('maxLength') })
  pattern!: string;

  @ApiProperty({ description: 'True = may be fetched, false = may not. Read against the mode.' })
  @IsBoolean()
  allow!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Why this row exists' })
  @IsOptional()
  @NULLABLE<CreateSourcePolicyDto>('note')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  note?: string | null;
}

export class UpdateSourcePolicyDto {
  @ApiPropertyOptional({ example: 'docs.example.com' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(253, { message: vmsg('maxLength') })
  pattern?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @NULLABLE<UpdateSourcePolicyDto>('note')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  note?: string | null;
}

/** Dry-run one URL against the workspace's list, without spending a chat turn. */
export class CheckSourcePolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'https://docs.example.com/guide', description: 'A URL, or a bare host' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  url!: string;
}
