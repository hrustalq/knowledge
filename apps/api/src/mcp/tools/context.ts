import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnalyticsCaller } from '../../analytics/analytics.recorder.js';
import type { Principal } from '../../auth/principal.js';
import type { McpExtras, McpService } from '../mcp.service.js';

/**
 * What one section's registrar gets from `McpService.buildServer` (#822): the
 * server, the caller and its guards, and the service whose injected
 * collaborators the handlers call. Handlers read `svc.<service>` when they run,
 * never at registration, so a spec may swap a collaborator after construction.
 * Every tool handler still starts with its `guard.*` call.
 */
export interface McpToolContext {
  server: McpServer;
  principal: Principal;
  caller: AnalyticsCaller;
  extras: McpExtras;
  guard: McpGuard;
  svc: McpService;
}

export type McpGuard = ReturnType<McpService['guardFor']>;

export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
