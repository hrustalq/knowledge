import {
  IsInt,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { vmsg } from '../common/validation.js';

export class ListProjectsQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Case-insensitive name/description substring match' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  /** Omitted = the whole roster in one response (what the sidebar switchers want). */
  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'Omit for the full roster' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(200, { message: vmsg('max') })
  limit?: number;
}

export class CreateProjectDto {
  // Field name must stay `workspaceId`: @Access('editor', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  // Explicit `type: String` on a nullable property — without it openapi-typescript
  // emits Record<string, never> and the web typecheck breaks at every call site.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: CreateProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  description?: string | null;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  /** `null` clears the description; omitting the field leaves it untouched. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  description?: string | null;
}
