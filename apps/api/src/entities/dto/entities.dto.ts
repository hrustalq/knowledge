import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { vmsg } from '../../common/validation.js';
import { AS_OF_DESCRIPTION, KNOWN_AT_DESCRIPTION } from '../../temporal/temporal.dto.js';

export class ImpactAnalysisDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ enum: ['dependents', 'dependencies'], description: 'Default: dependents.' })
  @IsOptional()
  @IsIn(['dependents', 'dependencies'])
  direction?: 'dependents' | 'dependencies';

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Default: 3.' })
  @IsOptional()
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(5, { message: vmsg('max') })
  maxDepth?: number;

  @ApiPropertyOptional({ description: AS_OF_DESCRIPTION })
  @IsOptional()
  @IsString()
  asOf?: string;

  @ApiPropertyOptional({ description: KNOWN_AT_DESCRIPTION })
  @IsOptional()
  @IsString()
  knownAt?: string;
}

export class CreateEntityAliasDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  /**
   * Both keys are folded server-side, so the caller may send whichever spelling
   * they are looking at. Describing that in `description:` rather than giving
   * the property a `default:` is deliberate — `openapi-typescript` promotes any
   * property declaring a default to required in the generated client.
   */
  @ApiProperty({ description: 'The spelling to retire, e.g. "сервис:биллинг". Normalized server-side.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  alias!: string;

  @ApiProperty({ description: 'The spelling to keep, e.g. "service:billing". Normalized server-side.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  canonicalKey!: string;
}
