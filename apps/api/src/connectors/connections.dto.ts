import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CONNECTION_PROVIDERS, CONNECTOR_KINDS, type ConnectionProvider, type ConnectorKind } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class CreateTokenConnectionDto {
  // Field name must stay `workspaceId`: @Access('admin','body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: CONNECTION_PROVIDERS })
  @IsIn(CONNECTION_PROVIDERS as unknown as string[])
  provider!: ConnectionProvider;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The site for providers that are not one fixed host: an Atlassian site, a GitLab instance (gitlab.com when empty)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  site?: string | null;

  @ApiProperty({ description: 'Write-only. Encrypted at rest; never returned.' })
  @IsString()
  @IsNotEmpty()
  // A Google service account JSON key is ~2.4 KB; a token is far less.
  @MaxLength(8000, { message: vmsg('maxLength') })
  credential!: string;
}

export class UpdateConnectionDto {
  @ApiProperty({ description: 'A new token for the same account. Write-only.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000, { message: vmsg('maxLength') })
  credential!: string;
}

export class ConnectionLinkDto {
  @ApiProperty({ enum: CONNECTOR_KINDS })
  @IsIn(CONNECTOR_KINDS as unknown as string[])
  kind!: ConnectorKind;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'The resource label, for the connector name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  label!: string;

  // A typeless object schema makes openapi-typescript emit Record<string, never>.
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  @IsObject()
  config!: Record<string, string>;
}

export class CreateConnectionLinksDto {
  @ApiProperty({ type: [ConnectionLinkDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConnectionLinkDto)
  links!: ConnectionLinkDto[];
}
