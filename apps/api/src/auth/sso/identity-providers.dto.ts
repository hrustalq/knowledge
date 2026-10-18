import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  GROUP_SYNC_MODES,
  IDP_KINDS,
  IDP_PRESETS,
  WORKSPACE_ROLES,
  type GroupSyncMode,
  type IdpKind,
  type IdpPreset,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { vmsg } from '../../common/validation.js';

/**
 * The editable fields of an identity provider (#75). The OIDC settings are
 * flat here and stored as `identity_providers.config`; the client secret is
 * write-only — sent to set it, `''` to clear it, absent to keep it.
 */
class IdentityProviderFieldsDto {
  @ApiPropertyOptional({ enum: IDP_PRESETS, description: 'IdP quirks to apply. Defaults to generic.' })
  @IsOptional()
  @IsIn(IDP_PRESETS)
  preset?: IdpPreset;

  @ApiPropertyOptional({ description: 'Offered for sign-in. New providers start disabled.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Shown as a button on /login (otherwise reached by email discovery only)' })
  @IsOptional()
  @IsBoolean()
  showOnLogin?: boolean;

  @ApiPropertyOptional({ description: 'Offered on every login page of the instance. Platform admins only.' })
  @IsOptional()
  @IsBoolean()
  platformWide?: boolean;

  @ApiPropertyOptional({ description: 'OIDC issuer identifier. Ignored by the google and yandex presets, which fix it.' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  issuer?: string;

  @ApiPropertyOptional({ description: 'OIDC client id' })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  clientId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Scopes beyond openid; empty uses the preset defaults' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true, message: vmsg('maxLength') })
  scopes?: string[];

  @ApiPropertyOptional({ description: "Write-only. A value sets it, '' clears it, absent keeps it." })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  clientSecret?: string;

  @ApiPropertyOptional({ description: 'Create an account on first sign-in (needs the address in allowedDomains)' })
  @IsOptional()
  @IsBoolean()
  jitEnabled?: boolean;

  @ApiPropertyOptional({ type: String, enum: WORKSPACE_ROLES, nullable: true, description: 'Membership a JIT sign-in gets; null = none' })
  @IsOptional()
  @IsIn(WORKSPACE_ROLES)
  defaultRole?: WorkspaceRole | null;

  @ApiPropertyOptional({ type: [String], description: 'Email domains this provider may assert, e.g. corp.example' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(253, { each: true, message: vmsg('maxLength') })
  allowedDomains?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Claim holding group names; null uses the preset default' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: vmsg('maxLength') })
  groupsClaim?: string | null;

  @ApiPropertyOptional({ enum: GROUP_SYNC_MODES })
  @IsOptional()
  @IsIn(GROUP_SYNC_MODES)
  groupSyncMode?: GroupSyncMode;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Session lifetime for this provider; null = AUTH_SESSION_TTL_HOURS' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  sessionTtlHours?: number | null;
}

export class CreateIdentityProviderDto extends IdentityProviderFieldsDto {
  @ApiProperty({ enum: IDP_KINDS, description: 'Only oidc is accepted until SAML and LDAP ship' })
  @IsIn(IDP_KINDS)
  kind!: IdpKind;

  @ApiProperty({ description: 'The login button label' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name!: string;
}

export class UpdateIdentityProviderDto extends IdentityProviderFieldsDto {
  @ApiPropertyOptional({ description: 'The login button label' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name?: string;
}

export class SsoDiscoverDto {
  @ApiProperty({ example: 'you@corp.example' })
  @IsEmail()
  email!: string;
}

export class SsoExchangeDto {
  @ApiProperty({ description: 'The single-use code from the /auth/sso/complete fragment' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  code!: string;
}
