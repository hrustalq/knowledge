import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GraphQueryResponse } from '@knowledge/contracts';
import { AuditService } from '../auth/audit.service.js';
import type { Env } from '../config/env.js';
import { GraphService } from './graph.service.js';

/**
 * The trusted-operator graph query (plan.md §9) for both surfaces — REST
 * `POST /v1/graph/query` and MCP `knowledge_query_graph` (#812): the
 * `GRAPH_QUERY_MAX_ROWS` ceiling, the query and its audit row, in one place so
 * neither caller can drop one. The caller has already checked admin + operator.
 */
@Injectable()
export class GraphQueryService {
  constructor(
    private readonly graph: GraphService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async run(workspaceId: string, query: string, requested: number | undefined, actor: string): Promise<GraphQueryResponse> {
    const maxRows = this.config.get('GRAPH_QUERY_MAX_ROWS', { infer: true });
    const limit = Math.min(requested ?? maxRows, maxRows);
    const started = Date.now();
    const base = {
      workspaceId,
      actor,
      action: 'graph.query' as const,
      // The query reads raw stores past every page restriction (#76): only an
      // admin operator reaches it, and admins bypass restrictions anyway, but
      // the row says so in as many words.
      params: { query, limit, aclBypass: true },
    };
    try {
      const { rows, truncated } = await this.graph.operatorQuery(workspaceId, query, limit);
      const durationMs = Date.now() - started;
      await this.audit.record({ ...base, rowCount: rows.length, durationMs, ok: true });
      return { rows, rowCount: rows.length, truncated, durationMs };
    } catch (e) {
      await this.audit.record({ ...base, durationMs: Date.now() - started, ok: false, error: (e as Error).message });
      throw e;
    }
  }
}
