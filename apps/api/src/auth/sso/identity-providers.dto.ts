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
  IsUUID,
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
 * The editable fields of an identity provider (#75). The OIDC, SAML and LDAP
 * settings are flat here and stored as `identity_providers.config`; each kind
 * ignores the others'. The OIDC client secret and the LDAP bind password are
 * write-only — sent to set, `''` to clear, absent to keep. A SAML provider's
 * SP key is made on create and is not editable.
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

  @ApiPropertyOptional({ description: "SAML: the IdP's entity ID, which the assertion's Issuer must equal" })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  idpEntityId?: string;

  @ApiPropertyOptional({ description: "SAML: the IdP's single sign-on URL (HTTP-Redirect binding)" })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  ssoUrl?: string;

  @ApiPropertyOptional({ description: "SAML: the IdP's signing certificate(s), PEM; two during a rollover" })
  @IsOptional()
  @IsString()
  @MaxLength(20000, { message: vmsg('maxLength') })
  idpCert?: string;

  @ApiPropertyOptional({ description: "SAML: accept responses no AuthnRequest of ours asked for (the IdP's app portal). Defaults to false." })
  @IsOptional()
  @IsBoolean()
  allowIdpInitiated?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'SAML / LDAP: attribute holding the email; null tries the usual names (SAML) or reads mail (LDAP)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  emailAttribute?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'SAML / LDAP: attribute holding the display name; null tries the usual names' })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  nameAttribute?: string | null;

  @ApiPropertyOptional({ description: 'LDAP: ldaps://host[:port], or ldap://host[:port] with startTls' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  ldapUrl?: string;

  @ApiPropertyOptional({ description: 'LDAP: upgrade an ldap:// connection with StartTLS. Ignored for ldaps://' })
  @IsOptional()
  @IsBoolean()
  startTls?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'LDAP: the service account that searches; null searches anonymously' })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  bindDn?: string | null;

  @ApiPropertyOptional({ description: "Write-only. LDAP: the service account's password. A value sets it, '' clears it, absent keeps it." })
  @IsOptional()
  @IsString()
  @MaxLength(1024, { message: vmsg('maxLength') })
  bindPassword?: string;

  @ApiPropertyOptional({ description: 'LDAP: where the person search starts, e.g. ou=people,dc=corp,dc=example' })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  baseDn?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'LDAP: search filter with {username} where the typed value goes (escaped); null uses the default',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: vmsg('maxLength') })
  userFilter?: string | null;

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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'OIDC claim (null uses the preset default), SAML attribute (null = no groups) or LDAP attribute (null = memberOf) holding group names',
  })
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
  @ApiProperty({ enum: IDP_KINDS, description: 'oidc, saml, or ldap (only under AUTH_LDAP_ENABLED)' })
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

export class LdapLoginDto {
  @ApiProperty({ description: 'What the directory knows the person by: uid, sAMAccountName, userPrincipalName or email, per the provider filter' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256, { message: vmsg('maxLength') })
  username!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024, { message: vmsg('maxLength') })
  password!: string;
}

export class SsoExchangeDto {
  @ApiProperty({ description: 'The single-use code from the /auth/sso/complete fragment' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  code!: string;
}

export class UpsertGroupMappingDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: "One of the workspace's identity providers, or a platform-wide one. Null or absent maps a SCIM group.",
  })
  @IsOptional()
  @IsUUID()
  providerId?: string | null;

  @ApiProperty({
    description: "The group exactly as the provider's groups claim carries it; for a SCIM mapping, the SCIM group's id",
    example: 'knowledge-editors',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256, { message: vmsg('maxLength') })
  externalGroup!: string;

  @ApiProperty({ enum: WORKSPACE_ROLES })
  @IsIn(WORKSPACE_ROLES)
  role!: WorkspaceRole;

  @ApiPropertyOptional({ description: 'Also grant the trusted-operator flag (POST /v1/graph/query). Defaults to false.' })
  @IsOptional()
  @IsBoolean()
  trustedOperator?: boolean;
}
