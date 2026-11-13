import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CAPTURE_TITLE_MAX_CHARS, MEMORY_PROMOTE_KINDS, MEMORY_UNIT_TYPES, type MemoryPromoteKind, type MemoryUnitType } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** This platform's own memory routes (#994), for the web. The Hindsight-shaped bodies are in memory.dto.ts. */

export class MemoryBanksQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

/** A page of a bank's memories, entities or files. */
export class MemoryPageQueryDto {
  @ApiPropertyOptional({ description: 'Words the text contains: a memory\'s, an entity\'s name, type or observations, a file\'s path' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  q?: string;

  @ApiPropertyOptional({ type: Number, description: 'At most 200; 50 when left out' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class MemoryUnitsQueryDto extends MemoryPageQueryDto {
  @ApiPropertyOptional({ enum: MEMORY_UNIT_TYPES })
  @IsOptional()
  @IsIn(MEMORY_UNIT_TYPES)
  type?: MemoryUnitType;
}

export class DeleteMemoryBankQueryDto {
  @ApiProperty({ description: 'The bank id, typed: a delete without it is refused' })
  @IsString()
  confirm!: string;
}

export class BindMemoryBankDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The project whose restriction the bank follows, or null for the whole workspace' })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  projectId!: string | null;
}

export class PromoteMemoryDto {
  @ApiProperty({ format: 'uuid', description: 'The project the page is proposed in' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'The page title' })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(CAPTURE_TITLE_MAX_CHARS, { message: vmsg('maxLength') })
  title!: string;

  @ApiProperty({ enum: MEMORY_PROMOTE_KINDS, description: 'Which kind of note the page is written as' })
  @IsIn(MEMORY_PROMOTE_KINDS)
  kind!: MemoryPromoteKind;
}
