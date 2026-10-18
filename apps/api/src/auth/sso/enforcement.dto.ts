import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { vmsg } from '../../common/validation.js';

/**
 * PUT /v1/workspaces/:id/auth-policy (#75 phase 4). The whole policy every
 * time: a field left out or null inherits the instance default.
 */
export class PutAuthPolicyDto {
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: "Sessions must come from the workspace's identity providers. Null is off." })
  @IsOptional()
  @IsBoolean()
  ssoEnforced?: boolean | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true, description: 'Under enforced SSO, kn_ API keys still open the workspace. Null is yes.' })
  @IsOptional()
  @IsBoolean()
  allowApiKeys?: boolean | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description: "Platform admins may still sign in with a password on the workspace's enforced domains. Null is no.",
  })
  @IsOptional()
  @IsBoolean()
  allowPasswordForAdmins?: boolean | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Sessions older than this must sign in again for this workspace. Applies only under AUTH_SESSION_TTL_HOURS. Null is no cap.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  sessionMaxAgeHours?: number | null;
}

export class ClaimSsoDomainDto {
  @ApiProperty({ example: 'corp.example', description: 'An email domain the workspace owns; proven by a DNS TXT record' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253, { message: vmsg('maxLength') })
  domain!: string;

  @ApiPropertyOptional({ description: "Where people on the domain are sent to sign in: one of the workspace's providers or a platform-wide one" })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}

export class UpdateSsoDomainDto {
  @ApiPropertyOptional({ description: 'Refuse passwords for addresses on the domain. Needs a verified domain.' })
  @IsOptional()
  @IsBoolean()
  enforced?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, description: "The provider people on the domain are sent to; null = any of the workspace's" })
  @IsOptional()
  @IsUUID()
  providerId?: string | null;
}

export class VerifySsoDomainDto {
  @ApiPropertyOptional({ description: 'Mark it verified without DNS (air-gapped installs). Platform admins only; audited.' })
  @IsOptional()
  @IsBoolean()
  manual?: boolean;
}
