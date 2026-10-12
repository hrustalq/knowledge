import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolSummary } from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';

/** The key every generated client config files this server under. */
export const MCP_SERVER_NAME = 'knowledge';

/**
 * Sent in `initialize`. Clients that surface server instructions (Claude Code
 * does) give the model this before it has called anything — so it is the
 * orientation a model needs to avoid the two mistakes it would otherwise make
 * first: guessing a workspaceId, and writing to a default branch.
 */
export const MCP_INSTRUCTIONS = [
  'Knowledge platform: a versioned documentation store with semantic search and a relation graph.',
  'Workspace > Project > Document. Every content tool takes a workspaceId — call knowledge_whoami first to get yours.',
  'Answer from the knowledge base with knowledge_search, and cite the document ids and titles it returns.',
  'Rate an answer you built from knowledge_search with knowledge_feedback (quote its traceId). If a page you read is wrong or out of date, call knowledge_report_issue with the evidence — a report is checked and may become a merge request, never a silent edit.',
  'Every search hit carries trust.status (verified | expired | edited | requested | outdated | flagged | unverified). Prefer verified pages; say so when you rely on an outdated, expired or edited one. knowledge_flag_document marks a page requested (please check) or outdated (known wrong) — verifying is a person\'s act and has no tool.',
  'To change an existing page: knowledge_create_branch → knowledge_create_revision → knowledge_create_merge_request. Do not merge your own merge request unless asked to.',
  'Read the knowledge://skill resource (or the "guide" prompt) for the full playbook.',
].join('\n');

/**
 * Tools that change the knowledge base. The complement is read-only, and gets
 * MCP's `readOnlyHint` — which is what lets a client auto-approve reads while
 * still asking before a write. A closed list rather than a flag at each
 * registration because it is also the offer filter for read-only keys, and one
 * list cannot disagree with itself.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'knowledge_create_document',
  'knowledge_create_branch',
  'knowledge_create_revision',
  'knowledge_create_merge_request',
  'knowledge_approve_merge_request',
  'knowledge_close_merge_request',
  'knowledge_comment_merge_request',
  'knowledge_merge_revision',
  'knowledge_start_workflow',
  'knowledge_sync_connector',
  'knowledge_ingest',
  // A vote writes a row the surveyor and the backtest read (docs/features/38).
  // Hidden from read-only keys like every other write; the REST vote routes
  // admit them, so a read key can still rate what it was shown.
  'knowledge_feedback',
  // A report writes an issue row, may queue a model run and may open a merge
  // request (docs/features/38, phase 3). The REST route admits a read key for
  // the row alone, the same split as the vote.
  'knowledge_report_issue',
  // Sets a page's declared verification flag (docs/features/39). There is
  // deliberately no verify tool: a stamp is a person's act.
  'knowledge_flag_document',
  // Puts a page in front of people outside the workspace (docs/features/43).
  'knowledge_share_page',
]);

/**
 * Keep a handle on every tool registered from here on.
 *
 * Wraps the instance rather than each call site, because `server.registerTool(
 * 'name', {` is a shape `generate-docs-reference.mjs` reads the source for.
 */
export function trackTools(server: McpServer): Map<string, RegisteredTool> {
  const handles = new Map<string, RegisteredTool>();
  const register = server.registerTool.bind(server) as (...args: unknown[]) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const handle = register(name, ...rest);
    handles.set(name, handle);
    return handle;
  }) as McpServer['registerTool'];
  return handles;
}

/**
 * Annotate every tool read-only or not, and drop the writes a read-only key
 * could never run — offering a tool that always 403s spends the model's
 * context on a dead end. Offering is not the check: each write tool still runs
 * `requireRole`, which refuses a read key on its own.
 */
export function settleTools(handles: Map<string, RegisteredTool>, principal: Principal): McpToolSummary[] {
  const readKey = principal.apiKey?.scope === 'read';
  const offered: McpToolSummary[] = [];
  for (const [name, handle] of handles) {
    const readOnly = !WRITE_TOOLS.has(name);
    if (readKey && !readOnly) {
      handle.remove();
      continue;
    }
    handle.update({ annotations: { ...handle.annotations, readOnlyHint: readOnly } });
    offered.push({ name, description: handle.description ?? '', readOnly });
  }
  return offered.sort((a, b) => a.name.localeCompare(b.name));
}
