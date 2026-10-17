import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import type { LintPolicy } from '@knowledge/contracts';

/**
 * What a scope may ask for today. `block` joins with the merge gate that
 * enforces it (#74, phase 3): a setting the code cannot honour is a setting
 * that lies.
 */
const SETTABLE_LINT_POLICIES = ['off', 'warn'] as const satisfies readonly LintPolicy[];

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
    enum: SETTABLE_LINT_POLICIES,
    nullable: true,
    description: 'null inherits: a project the workspace, the workspace STYLE_LINT_POLICY',
  })
  @NULLABLE<UpdateLintPolicyDto>('policy')
  @IsIn(SETTABLE_LINT_POLICIES)
  policy!: LintPolicy | null;
}
