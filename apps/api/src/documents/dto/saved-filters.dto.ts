import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { vmsg } from '../../common/validation.js';

/** Long enough for a branch fragment or a display name, short enough to store inline. */
const MAX_VALUE_CHARS = 200;
/** The bar offers five axes today; the cap is headroom, not a design limit. */
const MAX_CHIPS = 20;

export class SavedFilterChipDto {
  @ApiProperty({ example: 'reviewer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64, { message: vmsg('maxLength') })
  key!: string;

  @ApiProperty({ example: 'is' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32, { message: vmsg('maxLength') })
  operator!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(10, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  @MaxLength(MAX_VALUE_CHARS, { each: true, message: vmsg('maxLength') })
  values!: string[];
}

export class SavedFilterQueryDto {
  @ApiPropertyOptional({
    enum: ['open', 'merged', 'closed', 'all'],
    description: "Status tab; 'all' (or absent) applies no status filter",
  })
  @IsOptional()
  @IsIn(['open', 'merged', 'closed', 'all'], { message: vmsg('isIn') })
  status?: 'open' | 'merged' | 'closed' | 'all';

  @ApiPropertyOptional({ description: 'Title substring' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_VALUE_CHARS, { message: vmsg('maxLength') })
  search?: string;

  @ApiProperty({ type: [SavedFilterChipDto] })
  @IsArray()
  @ArrayMaxSize(MAX_CHIPS, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => SavedFilterChipDto)
  chips!: SavedFilterChipDto[];
}

export class CreateSavedFilterDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'My open reviews' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ type: SavedFilterQueryDto })
  @ValidateNested()
  @Type(() => SavedFilterQueryDto)
  query!: SavedFilterQueryDto;
}

export class UpdateSavedFilterDto {
  @ApiPropertyOptional({ example: 'My open reviews' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ type: SavedFilterQueryDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SavedFilterQueryDto)
  query?: SavedFilterQueryDto;
}

export class ListSavedFiltersQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}
