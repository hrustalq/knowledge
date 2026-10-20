import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AgentOutcomesResponse } from '@knowledge/contracts';
import { Access } from '../auth/access.decorator.js';
import { AgentOutcomesQueryDto } from './agent-outcomes.dto.js';
import { AgentOutcomesService } from './agent-outcomes.service.js';

/**
 * The learning-loop ledger (#305): what became of each agent's output, for the
 * Agents tab of knowledge health. Admin-only, like the usage figures it sits
 * beside — counts only, never a title.
 */
@ApiTags('ai')
@Controller('v1/agent-outcomes')
export class AgentOutcomesController {
  constructor(private readonly outcomes: AgentOutcomesService) {}

  @Get()
  @Access('admin', 'query')
  @ApiOperation({
    summary:
      'Per agent, how many findings were accepted, dismissed or are pending, and how answers were voted; ' +
      'optionally split by prompt hash or model. Derived on read from runs, merge requests and votes',
  })
  list(@Query() query: AgentOutcomesQueryDto): Promise<AgentOutcomesResponse> {
    return this.outcomes.outcomes(query);
  }
}
