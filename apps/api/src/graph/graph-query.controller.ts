import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GraphQueryResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { GraphQueryDto } from './graph-query.dto.js';
import { GraphQueryService } from './graph-query.service.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Phase 5 (plan.md §7/§9): POST /v1/graph/query — trusted-operator-only,
 * read-only, row-limited, and audited. Everything else must use the
 * task-level endpoints/tools; this is the logged escape hatch.
 */
@ApiTags('graph')
@Controller('v1/graph')
export class GraphQueryController {
  constructor(private readonly graphQuery: GraphQueryService) {}

  @Post('query')
  @Returns('GraphQueryResponse')
  @HttpCode(200)
  @Access('admin', 'body', { operator: true })
  @ApiOperation({
    summary: 'Read-only graph query (trusted operator only; row-limited; every call is audited)',
  })
  run(@Body() dto: GraphQueryDto, @CurrentPrincipal() principal: Principal): Promise<GraphQueryResponse> {
    return this.graphQuery.run(dto.workspaceId, dto.query, dto.limit, principal.mode === 'dev' ? 'dev' : principal.userId);
  }
}
