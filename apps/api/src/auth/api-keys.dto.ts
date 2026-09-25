import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { API_KEY_SCOPES, type ApiKeyScope } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class CreateApiKeyDto {
  @ApiProperty({ description: 'What the key is for — "Claude Code on my laptop". Shown in the key list.' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name!: string;

  @ApiPropertyOptional({
    enum: API_KEY_SCOPES,
    description: "'read' caps every workspace at the viewer role. Omitted means 'write' (the owner's own role).",
  })
  @IsOptional()
  @IsIn(API_KEY_SCOPES as readonly string[], { message: vmsg('isIn') })
  scope?: ApiKeyScope;

  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'Pin the key to one workspace; omit for all of yours.' })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiPropertyOptional({ type: Number, description: 'Days until the key stops working (1–365); omit for no expiry.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
