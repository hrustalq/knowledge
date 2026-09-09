import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { CONNECTOR_KINDS, DOCUMENT_CATEGORIES } from '@knowledge/contracts';
import type {
  ConnectorConflictPolicy,
  ConnectorDirection,
  ConnectorKind,
  ConnectorRunDirection,
  DocumentCategory,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

const DIRECTIONS = ['pull', 'push', 'both'];
const CONFLICTS = ['manual', 'external-wins', 'local-wins'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `null` clears and absent keeps, so nullable fields use ValidateIf rather than
 * IsOptional alone (the UpdateMergeRequestDto.assigneeId precedent). Nullable
 * Swagger properties also need an explicit `type:` or openapi-typescript emits
 * `Record<string, never>` and the web typecheck breaks at every call site.
 */
const NULLABLE = <T extends object>(field: keyof T) => ValidateIf((o: T) => o[field] !== null);

export class CreateConnectorDto {
  // Field name must stay `workspaceId`: @Access('admin','body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: CONNECTOR_KINDS })
  @IsIn(CONNECTOR_KINDS as unknown as string[])
  kind!: ConnectorKind;

  @ApiProperty({ example: 'Product wiki' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ format: 'uuid', description: 'Where pulled pages land; must belong to workspaceId' })
  @IsUUID()
  projectId!: string;

  // A typeless object schema makes openapi-typescript emit Record<string, never>,
  // which breaks the web typecheck at every call site; the value type is declared.
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Kind-specific settings; see CONNECTOR_KIND_INFO',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Write-only. Encrypted at rest; never returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  credential?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Create pulled pages under this page' })
  @IsOptional()
  @NULLABLE<CreateConnectorDto>('parentId')
  @Matches(UUID_RE)
  parentId?: string | null;

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES, description: "Defaults to 'other'" })
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[])
  category?: DocumentCategory;

  @ApiPropertyOptional({ enum: DIRECTIONS, description: "Defaults to 'pull'" })
  @IsOptional()
  @IsIn(DIRECTIONS)
  direction?: ConnectorDirection;

  @ApiPropertyOptional({ enum: CONFLICTS, description: "Defaults to 'manual' — opens a merge request" })
  @IsOptional()
  @IsIn(CONFLICTS)
  conflict?: ConnectorConflictPolicy;

  @ApiPropertyOptional({ description: 'Defaults to false' })
  @IsOptional()
  @IsBoolean()
  pushOnPublish?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 5, maximum: 10080, description: 'null = manual only' })
  @IsOptional()
  @NULLABLE<CreateConnectorDto>('syncIntervalMinutes')
  @IsInt()
  @Min(5, { message: vmsg('min') })
  @Max(10080, { message: vmsg('max') })
  syncIntervalMinutes?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only. Enables the inbound webhook.' })
  @IsOptional()
  @NULLABLE<CreateConnectorDto>('webhookSecret')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  webhookSecret?: string | null;

  @ApiPropertyOptional({ description: 'Defaults to true' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Workspace comes from the `:id` path entity, so it is deliberately absent here. */
export class UpdateConnectorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  config?: Record<string, string>;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only. null clears the stored credential.' })
  @IsOptional()
  @NULLABLE<UpdateConnectorDto>('credential')
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  credential?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @NULLABLE<UpdateConnectorDto>('parentId')
  @Matches(UUID_RE)
  parentId?: string | null;

  @ApiPropertyOptional({ enum: DOCUMENT_CATEGORIES })
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES as unknown as string[])
  category?: DocumentCategory;

  @ApiPropertyOptional({ enum: DIRECTIONS })
  @IsOptional()
  @IsIn(DIRECTIONS)
  direction?: ConnectorDirection;

  @ApiPropertyOptional({ enum: CONFLICTS })
  @IsOptional()
  @IsIn(CONFLICTS)
  conflict?: ConnectorConflictPolicy;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pushOnPublish?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 5, maximum: 10080 })
  @IsOptional()
  @NULLABLE<UpdateConnectorDto>('syncIntervalMinutes')
  @IsInt()
  @Min(5, { message: vmsg('min') })
  @Max(10080, { message: vmsg('max') })
  syncIntervalMinutes?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Write-only. null disables the inbound webhook.' })
  @IsOptional()
  @NULLABLE<UpdateConnectorDto>('webhookSecret')
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  webhookSecret?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class StartConnectorSyncDto {
  @ApiPropertyOptional({ enum: ['pull', 'push'], description: "Defaults to 'pull'" })
  @IsOptional()
  @IsIn(['pull', 'push'])
  direction?: ConnectorRunDirection;

  @ApiPropertyOptional({ type: [String], description: 'Limit the run to these external items' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  externalIds?: string[];
}
