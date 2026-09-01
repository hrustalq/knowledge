import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GraphQueryResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { GraphQueryDto } from './graph-query.dto.js';
import { GraphService } from './graph.service.js';

/**
 * Phase 5 (plan.md §7/§9): POST /v1/graph/query — trusted-operator-only,
 * read-only, row-limited, and audited. Everything else must use the
 * task-level endpoints/tools; this is the logged escape hatch.
 */
@ApiTags('graph')
@Controller('v1/graph')
export class GraphQueryController {
  constructor(
    private readonly graph: GraphService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('query')
  @HttpCode(200)
  @Access('admin', 'body', { operator: true })
  @ApiOperation({
    summary: 'Read-only graph query (trusted operator only; row-limited; every call is audited)',
  })
  async run(@Body() dto: GraphQueryDto, @CurrentPrincipal() principal: Principal): Promise<GraphQueryResponse> {
    const maxRows = this.config.get('GRAPH_QUERY_MAX_ROWS', { infer: true });
    const limit = Math.min(dto.limit ?? maxRows, maxRows);
    const started = Date.now();
    const base = {
      workspaceId: dto.workspaceId,
      actor: principal.mode === 'dev' ? 'dev' : principal.userId,
      action: 'graph.query',
      params: { query: dto.query, limit },
    };
    try {
      const { rows, truncated } = await this.graph.operatorQuery(dto.workspaceId, dto.query, limit);
      const durationMs = Date.now() - started;
      await this.audit.record({ ...base, rowCount: rows.length, durationMs, ok: true });
      return { rows, rowCount: rows.length, truncated, durationMs };
    } catch (e) {
      await this.audit.record({
        ...base,
        durationMs: Date.now() - started,
        ok: false,
        error: (e as Error).message,
      });
      throw e;
    }
  }
}
