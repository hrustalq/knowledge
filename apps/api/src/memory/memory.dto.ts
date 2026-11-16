import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { FACT_TYPES, MEMORY_TIME_FIELDS, TAGS_MATCH, type MemoryTimeField, type TagsMatch } from './memory-facts.js';

/**
 * Request bodies in Hindsight's wire shape (#986): snake_case, every field
 * decorated — the global ValidationPipe strips what is not, which is also how
 * the fields of Hindsight this server does not implement are ignored.
 */

export class DispositionDto {
  @IsInt() @Min(1) @Max(5) skepticism!: number;
  @IsInt() @Min(1) @Max(5) literalism!: number;
  @IsInt() @Min(1) @Max(5) empathy!: number;
}

/** `CreateBankRequest`: PUT creates or updates, PATCH updates. A field left out is left as it is. */
export class BankBodyDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) mission?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) reflect_mission?: string | null;
  /** Hindsight's older name for `mission`. */
  @IsOptional() @IsString() @MaxLength(4000) background?: string | null;
  @IsOptional() @ValidateNested() @Type(() => DispositionDto) disposition?: DispositionDto | null;
  @IsOptional() @IsInt() @Min(1) @Max(5) disposition_skepticism?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(5) disposition_literalism?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(5) disposition_empathy?: number | null;
}

/** `BankConfigUpdate`: the keys are read by `readConfigUpdates`, which names any it does not keep. */
export class BankConfigUpdateDto {
  @IsObject() updates!: Record<string, unknown>;
}

/** `UpdateDispositionRequest`. */
export class UpdateDispositionDto {
  @IsDefined() @ValidateNested() @Type(() => DispositionDto) disposition!: DispositionDto;
}

export class ListBanksQueryDto {
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * `RetainRequest`. The items are checked by `readRetainItems`, not here: an
 * item's `content` may only be a string, and that is a 400 this server words
 * itself rather than a validation list.
 */
export class RetainDto {
  @IsArray() items!: Array<Record<string, unknown>>;
  @IsOptional() @IsBoolean() async?: boolean | null;
  @IsOptional() @IsArray() @IsString({ each: true }) document_tags?: string[] | null;
  @IsOptional() @IsUUID() operation_id?: string | null;
}

export class ConsolidateDto {
  @IsOptional() @IsArray({ each: true }) observation_scopes?: string[][] | null;
}

export class UpdateDocumentDto {
  @IsDefined() observation_scopes!: unknown;
}

export class ListObservationScopesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** A query parameter sent once arrives as a string, sent twice as a list. */
const asList = ({ value }: { value: unknown }) => (value == null ? undefined : Array.isArray(value) ? value : [value]);

export class ListMemoriesQueryDto {
  @IsOptional() @IsIn([...FACT_TYPES, 'observation']) type?: string;
  @IsOptional() @IsString() @MaxLength(500) q?: string;
  @IsOptional() @IsString() @MaxLength(500) document_id?: string;
  @IsOptional() @Transform(asList) @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsIn(TAGS_MATCH) tags_match?: TagsMatch;
  @IsOptional() @IsIn(Object.keys(MEMORY_TIME_FIELDS)) time_field?: MemoryTimeField;
  @IsOptional() @IsISO8601() start_date?: string;
  @IsOptional() @IsISO8601() end_date?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ClearMemoriesQueryDto {
  @IsOptional() @IsIn([...FACT_TYPES, 'observation']) type?: string;
}

export class TemporalWindowDto {
  @IsISO8601() start!: string;
  @IsISO8601() end!: string;
}

export class MinScoresDto {
  @IsOptional() @IsNumber() semantic?: number | null;
  @IsOptional() @IsNumber() keyword?: number | null;
  @IsOptional() @IsNumber() reranker?: number | null;
  @IsOptional() @IsNumber() final?: number | null;
}

export class RerankDto {
  @IsOptional() @IsBoolean() prune?: boolean | null;
}

/** `include`: each key on with an object, off with null. Of their inner options only `source_facts`' token budgets are read. */
export class RecallIncludeDto {
  @IsOptional() @IsObject() entities?: Record<string, unknown> | null;
  @IsOptional() @IsObject() chunks?: Record<string, unknown> | null;
  @IsOptional() @IsObject() source_facts?: Record<string, unknown> | null;
}

/**
 * `RecallRequest`. `tag_groups`, `trace` and `query_timestamp` are
 * Hindsight's and are accepted by being left undeclared.
 */
export class RecallDto {
  @IsString() @MinLength(1) @MaxLength(4000) query!: string;
  @IsOptional() @IsBoolean() prefer_observations?: boolean | null;
  @IsOptional() @IsArray() @IsIn([...FACT_TYPES, 'observation'], { each: true }) types?: string[] | null;
  @IsOptional() @IsIn(['low', 'mid', 'high']) budget?: 'low' | 'mid' | 'high' | null;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) max_tokens?: number | null;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[] | null;
  @IsOptional() @IsIn(TAGS_MATCH) tags_match?: TagsMatch | null;
  @IsOptional() @ValidateNested() @Type(() => TemporalWindowDto) temporal_window?: TemporalWindowDto | null;
  @IsOptional() @ValidateNested() @Type(() => MinScoresDto) min_scores?: MinScoresDto | null;
  @IsOptional() @ValidateNested() @Type(() => RerankDto) rerank?: RerankDto | null;
  @IsOptional() @ValidateNested() @Type(() => RecallIncludeDto) include?: RecallIncludeDto | null;
}

export class ListOperationsQueryDto {
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(40) type?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

class DirectiveFieldsDto {
  @IsOptional() @IsInt() @Min(-1_000_000) @Max(1_000_000) priority?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(100, { each: true }) tags?: string[] | null;
}

export class CreateDirectiveDto extends DirectiveFieldsDto {
  @IsString() @Matches(/\S/) @MaxLength(200) name!: string;
  @IsString() @Matches(/\S/) @MaxLength(20_000) @Matches(/^([^\n]*\n){0,99}[^\n]*$/) content!: string;
}

export class UpdateDirectiveDto extends DirectiveFieldsDto {
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(200) name?: string | null;
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(20_000) @Matches(/^([^\n]*\n){0,99}[^\n]*$/) content?: string | null;
}

export class ListDirectivesQueryDto {
  @IsOptional() @Transform(asList) @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true }) tags?: string[];
  @IsOptional() @IsIn(['any', 'all', 'exact']) tags_match?: 'any' | 'all' | 'exact';
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() active_only?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ReflectIncludeDto {
  @IsOptional() @IsObject() facts?: Record<string, unknown> | null;
}

/** `ReflectRequest`. `tag_groups` is Hindsight's and is left undeclared. */
export class ReflectDto {
  @IsString() @MinLength(1) @MaxLength(4000) query!: string;
  /** Deprecated by Hindsight: appended to the query. */
  @IsOptional() @IsString() @MaxLength(4000) context?: string | null;
  @IsOptional() @IsIn(['low', 'mid', 'high']) budget?: 'low' | 'mid' | 'high' | null;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) max_tokens?: number | null;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[] | null;
  @IsOptional() @IsIn(TAGS_MATCH) tags_match?: TagsMatch | null;
  @IsOptional() @IsBoolean() apply_all_directives?: boolean | null;
  @IsOptional() @IsArray() @IsIn([...FACT_TYPES, 'observation'], { each: true }) fact_types?: string[] | null;
  @IsOptional() @IsBoolean() exclude_mental_models?: boolean | null;
  @IsOptional() @IsArray() @IsString({ each: true }) exclude_mental_model_ids?: string[] | null;
  @IsOptional() @IsObject() response_schema?: Record<string, unknown> | null;
  @IsOptional() @ValidateNested() @Type(() => ReflectIncludeDto) include?: ReflectIncludeDto | null;
}

export class MentalModelTriggerDto {
  @IsOptional() @IsIn(['low', 'mid', 'high']) budget?: 'low' | 'mid' | 'high' | null;
  @IsOptional() @IsIn(['full', 'delta']) mode?: 'full' | 'delta';
  @IsOptional() @IsBoolean() refresh_after_consolidation?: boolean;
  @IsOptional() @IsString() @MaxLength(100) refresh_cron?: string | null;
  @IsOptional() @IsString() @MaxLength(100) full_refresh_cron?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(31_536_000) min_refresh_interval_seconds?: number | null;
  @IsOptional() @IsArray() @IsIn([...FACT_TYPES, 'observation'], { each: true }) fact_types?: Array<'world' | 'experience' | 'observation'> | null;
  @IsOptional() @IsBoolean() exclude_mental_models?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) exclude_mental_model_ids?: string[] | null;
  @IsOptional() @IsIn(TAGS_MATCH) tags_match?: TagsMatch | null;
  @IsOptional() @IsArray() tag_groups?: unknown[] | null;
  @IsOptional() @IsBoolean() include_chunks?: boolean | null;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) recall_max_tokens?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) recall_chunks_max_tokens?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) reflect_search_observations_max_tokens?: number | null;
  @IsOptional() @IsBoolean() reflect_search_observations_include_entities?: boolean | null;
  @IsOptional() @IsObject() response_schema?: Record<string, unknown> | null;
  @IsOptional() @IsBoolean() keep_trace?: boolean;
}

export class CreateMentalModelDto {
  @IsOptional() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(192) id?: string | null;
  @IsString() @Matches(/\S/) @MaxLength(200) name!: string;
  @IsString() @Matches(/\S/) @MaxLength(4000) source_query!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true }) tags?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(200_000) max_tokens?: number;
  @IsOptional() @ValidateNested() @Type(() => MentalModelTriggerDto) trigger?: MentalModelTriggerDto;
}

export class UpdateMentalModelDto {
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(200) name?: string | null;
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(4000) source_query?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true }) tags?: string[] | null;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) max_tokens?: number | null;
  @IsOptional() @ValidateNested() @Type(() => MentalModelTriggerDto) trigger?: MentalModelTriggerDto | null;
}

export class ListMentalModelsQueryDto {
  @IsOptional() @Transform(asList) @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsIn(['any', 'all', 'exact']) tags_match?: 'any' | 'all' | 'exact';
  @IsOptional() @IsIn(['metadata', 'content', 'full']) detail?: 'metadata' | 'content' | 'full';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() exclude_pages?: boolean;
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() exclude_knowledge_pages?: boolean;
}

export class GetMentalModelQueryDto {
  @IsOptional() @IsIn(['metadata', 'content', 'full']) detail?: 'metadata' | 'content' | 'full';
}

export class RefreshMentalModelDto {
  @IsOptional() @IsIn(['full']) mode?: 'full' | null;
}
