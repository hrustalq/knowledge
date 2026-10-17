import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { LINT_POLICIES, type LintPolicy } from '@knowledge/contracts';

const NULLABLE = <T extends object>(field: keyof T) => ValidateIf((o: T) => o[field] !== null);

export class LintPolicyQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: "Omitted: the workspace's own policy" })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class UpdateLintPolicyDto {
  // Field name must stay `workspaceId`: @Access('admin', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: "Omitted or null: the workspace's policy. Set: the project's, which replaces it there.",
  })
  @IsOptional()
  @NULLABLE<UpdateLintPolicyDto>('projectId')
  @IsUUID()
  projectId?: string | null;

  @ApiProperty({
    type: String,
    enum: LINT_POLICIES,
    nullable: true,
    description: 'null inherits: a project the workspace, the workspace STYLE_LINT_POLICY',
  })
  @NULLABLE<UpdateLintPolicyDto>('policy')
  @IsIn(LINT_POLICIES)
  policy!: LintPolicy | null;
}

export class OverrideLintCheckDto {
  @ApiProperty({ maxLength: 500, description: 'Why the head may merge despite its check; kept with the override and in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
