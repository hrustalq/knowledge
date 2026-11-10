import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { PLAUD_CONFIRM_MODES, PLAUD_IMPORT_STATUSES, type PlaudConfirmMode, type PlaudImportStatus } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class PlaudRulesDto {
  @ApiPropertyOptional({ type: String, description: 'Only recordings started on or after this day, YYYY-MM-DD. Unset = the day the settings were first saved' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  since?: string;

  @ApiPropertyOptional({ type: Number, description: 'Only recordings at least this long, in seconds. Unset = 120' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  minSeconds?: number;

  @ApiPropertyOptional({ type: String, description: 'Only recordings whose Plaud name contains this' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  nameIncludes?: string;

  @ApiPropertyOptional({ type: String, description: 'Never recordings whose Plaud name contains this' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  nameExcludes?: string;

  @ApiPropertyOptional({ type: String, description: 'Only recordings from the device with this serial number' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: vmsg('maxLength') })
  serial?: string;

  @ApiPropertyOptional({ enum: PLAUD_CONFIRM_MODES, description: 'ask: each recording waits for a yes. auto: imported once Plaud has transcribed it. Unset = ask' })
  @IsOptional()
  @IsIn(PLAUD_CONFIRM_MODES as unknown as string[])
  confirm?: PlaudConfirmMode;
}

export class SavePlaudSettingsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Where picked recordings go; null switches auto-import off here' })
  @ValidateIf((o: SavePlaudSettingsDto) => o.projectId !== null)
  @IsUUID()
  projectId!: string | null;

  @ApiProperty({ type: PlaudRulesDto })
  @ValidateNested()
  @Type(() => PlaudRulesDto)
  rules!: PlaudRulesDto;
}

export class PlaudImportsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ enum: PLAUD_IMPORT_STATUSES })
  @IsOptional()
  @IsIn(PLAUD_IMPORT_STATUSES as unknown as string[])
  status?: PlaudImportStatus;
}

export class PlaudImportIdsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ type: [String], description: 'One or many; ids that are not my open recordings are ignored' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}
