import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';
import { BUILT_IN_BLUEPRINT_KEYS } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class ListBlueprintsQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Include hidden built-ins and switched-off saved blueprints (the settings view). Off by default.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeDisabled?: boolean;
}

const BLUEPRINT_BODY = {
  type: 'object',
  additionalProperties: true,
  description: 'A `Blueprint` (@knowledge/contracts), validated server-side by the same schema scaffold uses.',
} as const;

/** `POST /v1/blueprints`: a saved blueprint, or with `builtInKey` the workspace's override of a built-in. */
export class CreateBlueprintDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ enum: BUILT_IN_BLUEPRINT_KEYS, description: 'Override this built-in instead of adding a blueprint.' })
  @IsOptional()
  @IsIn(BUILT_IN_BLUEPRINT_KEYS, { message: vmsg('isIn') })
  builtInKey?: string;

  @ApiPropertyOptional(BLUEPRINT_BODY)
  @IsOptional()
  @IsObject()
  blueprint?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Boolean, description: 'False hides it from the Start step. Defaults to true.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateBlueprintDto {
  @ApiPropertyOptional({ ...BLUEPRINT_BODY, description: `${BLUEPRINT_BODY.description} A change appends a version.` })
  @IsOptional()
  @IsObject()
  blueprint?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `POST /v1/blueprints/derive`. */
export class DeriveBlueprintDto {
  @ApiProperty({ format: 'uuid', description: 'The workspace the new project is for; the model call is billed here.' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid', description: 'The project to read, in any workspace the caller belongs to.' })
  @IsUUID()
  projectId!: string;
}
