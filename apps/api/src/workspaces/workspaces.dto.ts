import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const ROLES = ['viewer', 'editor', 'admin'] as const;

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Platform Team' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
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
