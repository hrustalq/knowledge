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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  AGENT_CAPABILITIES,
  AGENT_LEARNING_MAX_CHARS,
  AGENT_LEARNING_SOURCES,
  AGENT_LEARNING_STATUSES,
  AGENT_RUN_MAX_DOCUMENTS,
  AGENT_SCHEDULE_KINDS,
  AGENT_SCHEDULE_TIME_PATTERN,
  AGENT_SURFACES,
  AGENT_TRIGGER_COOLDOWN_MAX_MINUTES,
  AGENT_TRIGGER_EVENTS,
  WEB_ACCESS_MODES,
  STYLE_RULE_ID_PATTERN,
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  type StyleRuleSeverity,
  type AgentCapability,
  type AgentLearningSource,
  type AgentLearningStatus,
  type AgentScheduleKind,
  type AgentTriggerEvent,
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

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 365,
    description: 'Days a quality score stands before the auditor re-scores an unchanged page (#74). Null inherits QUALITY_AUDIT_DAYS (7).',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('qualityAuditDays')
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(365, { message: vmsg('max') })
  qualityAuditDays?: number | null;

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

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'Whether the page AI actions menu may offer "Open in ChatGPT / Claude / Cursor" (issue #68). ' +
      'Clamped by the AI_EXTERNAL_ACTIONS_ENABLED ceiling: true under a false ceiling is stored, but ' +
      'the effective value stays false and the response reports source=clamped. null = inherit the ceiling.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('externalAiActions')
  @IsBoolean()
  externalAiActions?: boolean | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'Whether coding agents may propose agent-session captures (issue #73). Clamped by the CAPTURE_ENABLED ' +
      'ceiling; the response reports source=clamped. null = inherit the ceiling.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('captureEnabled')
  @IsBoolean()
  captureEnabled?: boolean | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Captures one API key may stage per rolling hour. Clamped by CAPTURE_PER_KEY_PER_HOUR. null = inherit.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('capturePerKeyPerHour')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  capturePerKeyPerHour?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Captures the workspace accepts per rolling day. Clamped by CAPTURE_PER_WORKSPACE_PER_DAY. null = inherit.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('capturePerWorkspacePerDay')
  @IsInt()
  @Min(0, { message: vmsg('min') })
  capturePerWorkspacePerDay?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Cosine to the nearest page at or above which a capture is a duplicate candidate (0–1). null = CAPTURE_DEDUPE_THRESHOLD.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('captureDedupeThreshold')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(1, { message: vmsg('max') })
  captureDedupeThreshold?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Cosine at or above which a capture amends the nearest page (0–1, never above the dedupe threshold). ' +
      'null = CAPTURE_AMEND_THRESHOLD.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('captureAmendThreshold')
  @IsNumber()
  @Min(0, { message: vmsg('min') })
  @Max(1, { message: vmsg('max') })
  captureAmendThreshold?: number | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The page new captured pages nest under; null for the project root.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiSettingsDto>('captureParentDocumentId')
  @IsUUID()
  captureParentDocumentId?: string | null;

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

// ---- Styleguides (#74) -----------------------------------------------------

export class StyleRuleExampleDto {
  @ApiProperty({ maxLength: STYLE_RULE_TEXT_MAX, example: 'Click on the button to save.' })
  @IsString()
  @MaxLength(STYLE_RULE_TEXT_MAX, { message: vmsg('maxLength') })
  bad!: string;

  @ApiProperty({ maxLength: STYLE_RULE_TEXT_MAX, example: 'Select Save.' })
  @IsString()
  @MaxLength(STYLE_RULE_TEXT_MAX, { message: vmsg('maxLength') })
  good!: string;
}

export class StyleRuleDto {
  @ApiProperty({ example: 'ui-verbs', description: 'Stable slug: lowercase letters, digits and dashes' })
  @IsString()
  @Matches(STYLE_RULE_ID_PATTERN)
  id!: string;

  @ApiProperty({ maxLength: STYLE_RULE_TEXT_MAX, example: 'Name UI actions with "select", never "click on".' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(STYLE_RULE_TEXT_MAX, { message: vmsg('maxLength') })
  text!: string;

  @ApiProperty({ enum: STYLE_RULE_SEVERITIES })
  @IsIn(STYLE_RULE_SEVERITIES)
  severity!: StyleRuleSeverity;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ type: StyleRuleExampleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => StyleRuleExampleDto)
  example?: StyleRuleExampleDto;
}

export class UpsertStyleguideDto {
  // Field name must stay `workspaceId`: @Access('admin', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: "Omitted or null: the workspace's styleguide. Set: the project's, which replaces it there.",
  })
  @IsOptional()
  @NULLABLE<UpsertStyleguideDto>('projectId')
  @IsUUID()
  projectId?: string | null;

  @ApiProperty({ example: 'House style' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ example: 'How we write user-facing docs' })
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  description!: string;

  @ApiProperty({ type: [StyleRuleDto], description: 'At most STYLEGUIDE_MAX_RULES; ids unique' })
  @IsArray()
  @ArrayMaxSize(200, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => StyleRuleDto)
  rules!: StyleRuleDto[];
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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: AGENT_SCHEDULE_KINDS,
    description: 'interval (every scheduleMinutes), daily or weekly (at scheduleTime). Null reads as interval.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('scheduleKind')
  @IsIn(AGENT_SCHEDULE_KINDS as unknown as string[], { message: vmsg('isIn') })
  scheduleKind?: AgentScheduleKind | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '09:00', description: 'HH:MM, 24-hour, in scheduleTimezone.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('scheduleTime')
  @IsString()
  @Matches(AGENT_SCHEDULE_TIME_PATTERN, { message: vmsg('matches') })
  scheduleTime?: string | null;

  @ApiPropertyOptional({
    type: [Number],
    nullable: true,
    example: [1, 2, 3, 4, 5],
    description: 'Weekdays a weekly schedule fires on, 0 = Sunday … 6 = Saturday.',
  })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('scheduleWeekdays')
  @IsArray()
  @ArrayMaxSize(7, { message: vmsg('arrayMaxSize') })
  @IsInt({ each: true })
  @Min(0, { each: true, message: vmsg('min') })
  @Max(6, { each: true, message: vmsg('max') })
  scheduleWeekdays?: number[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Europe/Moscow', description: 'IANA timezone. Null reads as UTC.' })
  @IsOptional()
  @NULLABLE<UpdateAiAgentDto>('scheduleTimezone')
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  scheduleTimezone?: string | null;

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

  @ApiPropertyOptional({
    type: [String],
    description:
      'Restrict a page-reading agent (curator, reviewer, glossarist) to these pages instead of the most ' +
      'recent ones. Pages the caller cannot open are skipped.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AGENT_RUN_MAX_DOCUMENTS, { message: vmsg('arrayMaxSize') })
  @IsUUID('all', { each: true })
  documentIds?: string[];
}

// ---- Agent triggers (#70) ---------------------------------------------------

/**
 * The filter fields, flat rather than nested: a `filter` object would need
 * nested validation for three optional fields. The service folds them into
 * `agent_triggers.filter` and drops the ones the event has no dimension for.
 */
class AgentTriggerFieldsDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Only events in this project. Null hears every project.' })
  @IsOptional()
  @NULLABLE<AgentTriggerFieldsDto>('projectId')
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true, description: 'Only pages in these categories (page and merge request events).' })
  @IsOptional()
  @NULLABLE<AgentTriggerFieldsDto>('categories')
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  @MaxLength(64, { each: true, message: vmsg('maxLength') })
  categories?: string[] | null;

  @ApiPropertyOptional({ type: [String], nullable: true, description: 'Only these connectors (connector syncs and pull requests).' })
  @IsOptional()
  @NULLABLE<AgentTriggerFieldsDto>('connectorIds')
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @IsUUID('all', { each: true })
  connectorIds?: string[] | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Only this branch. Absent, a page.indexed trigger hears the default branch only.',
  })
  @IsOptional()
  @NULLABLE<AgentTriggerFieldsDto>('branch')
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  branch?: string | null;

  @ApiPropertyOptional({ description: 'Enabling makes the caller the owner the runs execute as. Off unless sent.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: `Minutes before the same subject may fire this trigger again; 0 turns it off. Defaults to AGENT_TRIGGER_COOLDOWN_MINUTES.`,
  })
  @IsOptional()
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(AGENT_TRIGGER_COOLDOWN_MAX_MINUTES, { message: vmsg('max') })
  cooldownMinutes?: number;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Instruction seeded into every run this trigger starts.' })
  @IsOptional()
  @NULLABLE<AgentTriggerFieldsDto>('note')
  @IsString()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  note?: string | null;
}

export class CreateAgentTriggerDto extends AgentTriggerFieldsDto {
  // Field name must stay `workspaceId`: @Access('admin', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: AGENT_TRIGGER_EVENTS })
  @IsIn(AGENT_TRIGGER_EVENTS as unknown as string[], { message: vmsg('isIn') })
  event!: AgentTriggerEvent;
}

/** The event is fixed once created: a different event is a different trigger. */
export class UpdateAgentTriggerDto extends AgentTriggerFieldsDto {}

/**
 * Apply a recipe (#70). Only the timezone a time-of-day schedule is read in:
 * everything else is the recipe, and everything it writes starts disabled.
 */
export class ApplyAgentRecipeDto {
  // Field name must stay `workspaceId`: @Access('admin', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ type: String, example: 'Europe/Moscow', description: "IANA timezone for the recipe's schedule. Absent reads as UTC." })
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  timezone?: string;
}

// ---- Learnings (#70) ---------------------------------------------------------

/** Fields a learning shares between create and update. */
class AgentLearningScopeDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'The agent it teaches. Null teaches every agent.' })
  @IsOptional()
  @NULLABLE<AgentLearningScopeDto>('agentKey')
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  agentKey?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Applies only to work in this project. Null applies everywhere.' })
  @IsOptional()
  @NULLABLE<AgentLearningScopeDto>('projectId')
  @IsUUID()
  projectId?: string | null;
}

/**
 * Teach an agent something. Anyone with edit rights may propose; only an admin
 * may create a learning `active` — the controller checks, because the text
 * reaches a prompt the moment it is.
 */
export class CreateAgentLearningDto extends AgentLearningScopeDto {
  // Field name must stay `workspaceId`: @Access('editor', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ maxLength: AGENT_LEARNING_MAX_CHARS, description: 'The correction, in plain words.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AGENT_LEARNING_MAX_CHARS, { message: vmsg('maxLength') })
  text!: string;

  @ApiPropertyOptional({ enum: ['proposed', 'active'], description: 'Absent is proposed. Active needs an admin.' })
  @IsOptional()
  @IsIn(['proposed', 'active'], { message: vmsg('isIn') })
  status?: 'proposed' | 'active';

  @ApiPropertyOptional({ enum: AGENT_LEARNING_SOURCES, description: 'Where it came from. Absent is manual.' })
  @IsOptional()
  @IsIn(AGENT_LEARNING_SOURCES as unknown as string[], { message: vmsg('isIn') })
  sourceKind?: AgentLearningSource;

  @ApiPropertyOptional({ format: 'uuid', description: 'The thread, for a document-thread or mr-thread source.' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The run, for a finding source.' })
  @IsOptional()
  @IsUUID()
  runId?: string;

  @ApiPropertyOptional({ description: "The finding's position in its run, for a finding source." })
  @IsOptional()
  @IsInt()
  @Min(0, { message: vmsg('min') })
  findingIndex?: number;
}

/** Approve, edit or archive (admin). Making it active, or rewording an active one, records the caller as approver. */
export class UpdateAgentLearningDto extends AgentLearningScopeDto {
  @ApiPropertyOptional({ maxLength: AGENT_LEARNING_MAX_CHARS })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(AGENT_LEARNING_MAX_CHARS, { message: vmsg('maxLength') })
  text?: string;

  @ApiPropertyOptional({ enum: AGENT_LEARNING_STATUSES })
  @IsOptional()
  @IsIn(AGENT_LEARNING_STATUSES as unknown as string[], { message: vmsg('isIn') })
  status?: AgentLearningStatus;
}

/** Dismiss a finding; with `learning`, "Remember why" proposes one. */
export class DismissAgentFindingDto {
  @ApiPropertyOptional({
    maxLength: AGENT_LEARNING_MAX_CHARS,
    description: 'Why it was wrong, as a rule for next time. Becomes a proposed learning for this agent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(AGENT_LEARNING_MAX_CHARS, { message: vmsg('maxLength') })
  learning?: string;

  @ApiPropertyOptional({ description: 'The learning teaches every agent, not only the one that ran.' })
  @IsOptional()
  @IsBoolean()
  allAgents?: boolean;
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
