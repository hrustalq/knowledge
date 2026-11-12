import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { PURPOSE_INTERVIEW_MAX_ROUNDS, type InterviewRound, type PurposeInterviewResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { PurposeInterviewService } from './purpose-interview.service.js';

export class PurposeInterviewDto {
  @ApiPropertyOptional({ type: String, maxLength: 2000, description: "What the workspace is for, in the admin's words." })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    maxItems: PURPOSE_INTERVIEW_MAX_ROUNDS,
    description: 'Every round so far, each as it was returned with the answers added. There is no interview state on the server.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PURPOSE_INTERVIEW_MAX_ROUNDS)
  @IsObject({ each: true })
  rounds?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: 'boolean', description: 'Pick now from the answers so far, asking nothing more. Off unless sent.' })
  @IsOptional()
  @IsBoolean()
  finish?: boolean;
}

@ApiTags('workspaces')
@Controller('v1/workspaces')
export class PurposeInterviewController {
  constructor(private readonly purpose: PurposeInterviewService) {}

  // Deliberately not `@Feature('assistant')`: this is how a workspace decides
  // which sections it has, so it cannot sit behind one of them.
  @Post(':id/purpose/interview')
  @HttpCode(200)
  @Returns('PurposeInterviewResponse')
  @Access('admin', 'workspace')
  @ApiOperation({
    summary: 'One round of the purpose interview (workspace admin): questions, or the uses picked from the catalogue',
    description:
      'Writes nothing. `asking` carries the next round; `done` the uses picked, a reason for each and the sections ' +
      'they suggest off; `unavailable` means no model can be used here (none configured, the scaffolder agent is ' +
      'off, or the budget is spent) and the caller shows the checklist instead. `finish` or the third round always ' +
      'ends in `done`. Saving is `PUT :id/purpose`.',
  })
  interview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PurposeInterviewDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PurposeInterviewResponse> {
    // The DTO cannot name the contracts type; every question is re-read by `readRound` before the model sees it.
    const rounds = (dto.rounds ?? []) as unknown as InterviewRound[];
    return this.purpose.interview(id, { description: dto.description ?? '', rounds, finish: dto.finish === true }, principal);
  }
}
