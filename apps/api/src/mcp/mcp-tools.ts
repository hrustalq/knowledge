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
  'When the session settles something durable — a decision and why, a non-obvious gotcha, a team convention — record it with knowledge_capture_decision / knowledge_capture_note (check knowledge_find_similar first). Captures become merge requests a person reviews.',
  'Graph tools take asOf (an ISO date, rev:<revisionId> or tag:<release tag>) to answer as the knowledge base stood then; knowledge_list_release_tags lists the tags.',
  'Read the knowledge://skill resource (or the "guide" prompt) for the full playbook.',
].join('\n');

/** The `asOf` / `knownAt` arguments of the graph tools (#81), described once. */
export const MCP_AS_OF =
  'Answer as the knowledge base stood at a point: an ISO date, "rev:<revisionId>" or "tag:<release tag name>". Omit for now.';
export const MCP_KNOWN_AT =
  'What was believed at this ISO date: facts retracted since still show, facts written since do not. Omit for now.';

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
  // Queues a run that rewrites repo wiki pages (docs/features/46).
  'knowledge_regenerate_wiki',
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
  // Files an access request its managers are notified of (#76, phase 5).
  'knowledge_request_access',
  // Writes a proposed learning (#70); an admin approves it in the app.
  'knowledge_propose_agent_learning',
  // Queues a model run that opens a merge request with a drafted component page (#236).
  'knowledge_document_component',
  // Writes a suggestion into a page's shared draft (#316). HTTP only, with COLLAB_ENABLED.
  'knowledge_suggest_draft_edit',
  // Names an instant the graph can be read as of (#81).
  'knowledge_create_release_tag',
  // Resolves or dismisses a contradiction between pages (#81).
  'knowledge_resolve_conflict',
]);

/**
 * The agent-memory tools (issue #73): writes that only ever stage a capture
 * and open a merge request for a person to review. They are the one kind of
 * write a `capture` key is offered — and the only calls whose guard passes
 * `capture: true`, which is what lets that key through `requireKeyAllows`.
 * Writes like WRITE_TOOLS, and kept apart from it so neither list needs a
 * second flag: a tool is read-only when it is in neither. Registered by
 * `registerCaptureTools` (capture-tools.ts).
 */
export const CAPTURE_TOOLS: ReadonlySet<string> = new Set([
  'knowledge_capture_decision',
  'knowledge_capture_note',
  'knowledge_propose_glossary_term',
  'knowledge_propose_relation',
  'knowledge_propose_answer',
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
 * Annotate every tool read-only or not, and drop the writes a narrowed key
 * could never run — offering a tool that always 403s spends the model's
 * context on a dead end. A read key keeps the reads; a capture key the reads
 * and CAPTURE_TOOLS. Offering is not the check: each write tool still runs
 * `requireRole`, which refuses the key on its own.
 */
export function settleTools(handles: Map<string, RegisteredTool>, principal: Principal): McpToolSummary[] {
  const scope = principal.apiKey?.scope ?? 'write';
  const offered: McpToolSummary[] = [];
  for (const [name, handle] of handles) {
    const readOnly = !WRITE_TOOLS.has(name) && !CAPTURE_TOOLS.has(name);
    const kept = readOnly || scope === 'write' || (scope === 'capture' && CAPTURE_TOOLS.has(name));
    if (!kept) {
      handle.remove();
      continue;
    }
    handle.update({ annotations: { ...handle.annotations, readOnlyHint: readOnly } });
    offered.push({ name, description: handle.description ?? '', readOnly });
  }
  return offered.sort((a, b) => a.name.localeCompare(b.name));
}
