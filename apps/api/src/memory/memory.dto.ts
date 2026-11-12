import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
