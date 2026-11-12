import { Type } from 'class-transformer';
import { IsDefined, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

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
