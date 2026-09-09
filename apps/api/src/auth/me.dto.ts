import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SUPPORTED_LOCALES, type Locale } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class UpdateMeDto {
  @ApiPropertyOptional({ enum: SUPPORTED_LOCALES, description: 'UI + API language; omit to leave unchanged' })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES as readonly string[], { message: vmsg('isIn') })
  locale?: Locale;

  @ApiPropertyOptional({ description: 'Display name shown wherever this account acts; omit to leave unchanged' })
  @IsOptional()
  @IsString()
  // Trim before validating, so "   " is rejected as empty rather than accepted
  // and then silently dropped by the service's own trim — a 200 that changed
  // nothing is a worse answer than a 400.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  displayName?: string;
}
