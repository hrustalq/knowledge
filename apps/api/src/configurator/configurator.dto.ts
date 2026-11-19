import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { vmsg } from '../common/validation.js';

// Field names must stay `workspaceId`: @Access(…, 'body' | 'query') resolves them.

export class ProposeConfigurationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ minLength: 5, maxLength: 2000, description: 'What should happen, in the person\'s words.' })
  @IsString()
  @MinLength(5, { message: vmsg('minLength') })
  @MaxLength(2000, { message: vmsg('maxLength') })
  goal!: string;

  @ApiPropertyOptional({ type: String, example: 'Europe/Moscow', description: 'IANA zone a proposed time-of-day schedule is read in when the model names none. Absent reads as UTC.' })
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  timezone?: string;
}

/** The list query, and the dismiss body. */
export class ConfiguratorWorkspaceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class ApplyConfigurationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ type: [String], description: 'The pending changes to apply, by id (`c1`, …). All or nothing.' })
  @IsArray()
  @ArrayMinSize(1, { message: vmsg('arrayMinSize') })
  @ArrayMaxSize(50, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  @MaxLength(10, { each: true, message: vmsg('maxLength') })
  changeIds!: string[];
}
