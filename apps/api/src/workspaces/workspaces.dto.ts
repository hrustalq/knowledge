import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
import { MEMBER_CAPABILITIES, WORKSPACE_ROLES, type MemberCapability } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

const ROLES = WORKSPACE_ROLES;

export class ListCandidatesQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive email/display-name substring match' })
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: vmsg('maxLength') })
  q?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(50, { message: vmsg('max') })
  limit?: number;
}

export class DeleteWorkspaceQueryDto {
  @ApiPropertyOptional({ description: "The workspace's name, typed to confirm; anything else is a 400 that deletes nothing" })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  confirm?: string;
}

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Platform Team' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: vmsg('maxLength') })
  name!: string;
}

export class AddMemberDto {
  @ApiProperty({ example: 'teammate@example.com', description: 'Existing user email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: ROLES })
  @IsIn(ROLES)
  role!: (typeof ROLES)[number];

  @ApiPropertyOptional({ default: false, description: 'Gate for POST /v1/graph/query (plan.md §9)' })
  @IsOptional()
  @IsBoolean()
  trustedOperator?: boolean;

  @ApiPropertyOptional({
    enum: MEMBER_CAPABILITIES,
    isArray: true,
    description: 'Grained permissions beside the role (#468). Replaces the list; admins hold every one implicitly.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEMBER_CAPABILITIES.length)
  @IsIn(MEMBER_CAPABILITIES, { each: true })
  capabilities?: MemberCapability[];
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn(ROLES)
  role?: (typeof ROLES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trustedOperator?: boolean;

  @ApiPropertyOptional({
    enum: MEMBER_CAPABILITIES,
    isArray: true,
    description: 'Grained permissions beside the role (#468). Replaces the list; admins hold every one implicitly.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEMBER_CAPABILITIES.length)
  @IsIn(MEMBER_CAPABILITIES, { each: true })
  capabilities?: MemberCapability[];

  @ApiPropertyOptional({
    description:
      'Take an IdP-managed row (source jit/group/scim) over as manual. Without it such a row answers 409 managedByIdp.',
  })
  @IsOptional()
  @IsBoolean()
  convertToManual?: boolean;
}
