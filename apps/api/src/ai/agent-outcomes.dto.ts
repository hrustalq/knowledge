import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AGENT_OUTCOME_SPLITS, type AgentOutcomeSplit } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class AgentOutcomesQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ maxLength: 64, description: "Only this agent's runs; answers are left out when set" })
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  agentKey?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only findings and answers citing a page of this project' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Window start; 90 days back when absent' })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({ enum: AGENT_OUTCOME_SPLITS, description: 'none (the default) | prompt | model' })
  @IsOptional()
  @IsIn(AGENT_OUTCOME_SPLITS)
  split?: AgentOutcomeSplit;
}
