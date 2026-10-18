import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { SCIM_DEFAULT_ROLES, type ScimDefaultRole } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class CreateScimTokenDto {
  @ApiProperty({ description: 'What the token is for — "Entra ID provisioning". Shown in the token list.' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name!: string;
}

export class PutScimSettingsDto {
  @ApiProperty({
    enum: SCIM_DEFAULT_ROLES,
    description: "Role a provisioned user gets when no mapped SCIM group says more. 'none' grants nothing without a group.",
  })
  @IsIn(SCIM_DEFAULT_ROLES as readonly string[], { message: vmsg('isIn') })
  defaultRole!: ScimDefaultRole;
}
