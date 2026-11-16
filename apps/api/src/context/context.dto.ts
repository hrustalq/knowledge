import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CONTEXT_BUDGET, type ContextRequest } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class ContextDto implements ContextRequest {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ description: "A condensed query: the ticket's title and key terms, not the raw ticket" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000, { message: vmsg('maxLength') })
  query!: string;

  @ApiPropertyOptional({ description: "The repo's git remote (git@host:org/repo.git, https://host/org/repo); memory comes from the projects whose code or docs connector reads it" })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  repo?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Projects to read memory from, beside what repo resolves to' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: vmsg('arrayMaxSize') })
  @IsUUID('all', { each: true })
  projectIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Page, term or memory ids an earlier call already showed' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50, { message: vmsg('arrayMaxSize') })
  @IsString({ each: true })
  @MaxLength(64, { each: true, message: vmsg('maxLength') })
  exclude?: string[];

  @ApiPropertyOptional({ description: `Tokens for the answer; ${CONTEXT_BUDGET.default} when omitted, clamped to ${CONTEXT_BUDGET.min}–${CONTEXT_BUDGET.max}` })
  @IsOptional()
  @IsInt()
  budget?: number;
}
