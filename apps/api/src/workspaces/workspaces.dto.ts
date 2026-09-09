import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
import { vmsg } from '../common/validation.js';

const ROLES = ['viewer', 'editor', 'admin'] as const;

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
}
