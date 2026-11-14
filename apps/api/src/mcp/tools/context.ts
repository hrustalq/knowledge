import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pageText } from '../../common/page-text.js';
import type { UntrustedOrigin } from '../../common/untrusted.js';
import type { AnalyticsCaller } from '../../analytics/analytics.recorder.js';
import type { Principal } from '../../auth/principal.js';
import type { McpWhoami, StackSkill } from '../skill.js';
import type { McpServices } from '../mcp-services.js';

/**
 * What one section's registrar gets from `McpService.buildServer` (#822): the
 * server, the caller and its guards, and the injected collaborators the
 * handlers call (`McpServices`). Handlers read `svc.<service>` when they run,
 * never at registration, so a spec may swap a collaborator after construction.
 * Every tool handler still starts with its `guard.*` call.
 */
export interface McpToolContext {
  server: McpServer;
  principal: Principal;
  caller: AnalyticsCaller;
  guard: McpGuard;
  svc: McpServices;
  /** The caller's identity and reach, as knowledge_whoami returns it. */
  whoami(): Promise<McpWhoami>;
  /** The caller's SKILL.md, for the skill resource and the guide prompt. */
  skill(): Promise<string>;
  /** The same playbooks as a stack of skills (#945), for the per-skill resources. */
  stack(): Promise<StackSkill[]>;
  /** Whether this caller is offered the tool: what decides which stack resources are listed. */
  offered(tool: string): boolean;
}

export type McpGuard = ReturnType<McpServices['guardFor']>;

export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * A result that may carry text someone other than the caller wrote (#1136):
 * one line of plain JSON facts, then the text in one untrusted block. Every
 * registered tool either answers through this (or `wrapUntrusted`) or is
 * listed as plain, with why, in `test/mcp-page-text.spec.ts`.
 */
export function pageJson(tool: string, value: unknown) {
  return { content: [{ type: 'text' as const, text: pageText(value, tool, ORIGIN[tool] ?? 'document') }] };
}

/** Tools whose text is not a page's: the wrapper names where it came from instead. */
const ORIGIN: Record<string, UntrustedOrigin> = {
  knowledge_code_usages: 'repo',
  knowledge_list_api_operations: 'spec',
  knowledge_get_api_operation: 'spec',
  knowledge_diff_api_spec: 'spec',
  knowledge_list_work_items: 'task',
  knowledge_handoff_work_item: 'task',
  knowledge_get_page_insights: 'search',
  knowledge_list_memos: 'memo',
  knowledge_list_templates: 'template',
  knowledge_get_template: 'template',
  knowledge_get_draft: 'draft',
};
