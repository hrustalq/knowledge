import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { SHARE_PASSWORD_MAX_CHARS, SHARE_PASSWORD_MIN_CHARS } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class CreateShareLinkDto {
  @ApiPropertyOptional({ description: 'Also share every page under this one. Omitted reads as false' })
  @IsOptional()
  @IsBoolean()
  includeSubtree?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'When the link stops working. Omitted or null: never (needs a password unless the workspace allows otherwise). Clamped to SHARE_LINK_MAX_TTL_DAYS',
  })
  @ValidateIf((o: CreateShareLinkDto) => o.expiresAt !== undefined && o.expiresAt !== null)
  @IsISO8601()
  expiresAt?: string | null;

  @ApiPropertyOptional({ minLength: SHARE_PASSWORD_MIN_CHARS, maxLength: SHARE_PASSWORD_MAX_CHARS, description: 'Readers must enter it first' })
  @IsOptional()
  @IsString()
  @MinLength(SHARE_PASSWORD_MIN_CHARS, { message: vmsg('minLength') })
  @MaxLength(SHARE_PASSWORD_MAX_CHARS, { message: vmsg('maxLength') })
  password?: string;
}

export class UpdateShareLinkDto {
  @ApiPropertyOptional({ description: 'Also share every page under this one' })
  @IsOptional()
  @IsBoolean()
  includeSubtree?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time', description: 'Omit to keep; null for never' })
  @ValidateIf((o: UpdateShareLinkDto) => o.expiresAt !== undefined && o.expiresAt !== null)
  @IsISO8601()
  expiresAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Omit to keep; a string sets it (ends every unlocked session); null clears it',
  })
  @ValidateIf((o: UpdateShareLinkDto) => o.password !== undefined && o.password !== null)
  @IsString()
  @MinLength(SHARE_PASSWORD_MIN_CHARS, { message: vmsg('minLength') })
  @MaxLength(SHARE_PASSWORD_MAX_CHARS, { message: vmsg('maxLength') })
  password?: string | null;
}

export class UpdatePublishingSettingsDto {
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: 'Allow public share links; null goes back to the default (off)' })
  @ValidateIf((o: UpdatePublishingSettingsDto) => o.allowShareLinks !== undefined && o.allowShareLinks !== null)
  @IsBoolean()
  allowShareLinks?: boolean | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description: 'Allow a link with neither a password nor an expiry; null goes back to the default (off)',
  })
  @ValidateIf((o: UpdatePublishingSettingsDto) => o.allowPasswordlessShares !== undefined && o.allowPasswordlessShares !== null)
  @IsBoolean()
  allowPasswordlessShares?: boolean | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description: 'Allow publishing a project as a public docs site; null goes back to the default (off)',
  })
  @ValidateIf((o: UpdatePublishingSettingsDto) => o.allowPublicSites !== undefined && o.allowPublicSites !== null)
  @IsBoolean()
  allowPublicSites?: boolean | null;
}

export class UnlockShareDto {
  @ApiProperty({ maxLength: SHARE_PASSWORD_MAX_CHARS })
  @IsString()
  @MaxLength(SHARE_PASSWORD_MAX_CHARS, { message: vmsg('maxLength') })
  password!: string;
}
