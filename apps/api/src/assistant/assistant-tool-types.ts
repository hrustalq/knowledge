import { ASSISTANT_CODE_TOOL_NAMES } from '@knowledge/contracts';
import type { AssistantPrompt, AssistantSource, AssistantUiBlock } from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';

/**
 * The shared vocabulary of a tool run, in a leaf module on purpose.
 *
 * These lived in assistant.tools.ts, which is fine while one service owns every
 * tool. AssistantReadToolsService now owns the read half (so the agent worker
 * can run it without loading anything that writes), and it needs these types —
 * importing them back out of assistant.tools.ts would close a cycle in the
 * module graph. Type-only, so it would never bite at runtime, but `make deps`
 * checks for cycles and this codebase does not keep any. assistant.tools.ts
 * re-exports both names, so no existing importer changes.
 *
 * The name sets moved here for the runtime version of the same cycle
 * (docs/features/31). `assistant.client.ts` needs FREE_TOOLS and
 * PARALLEL_SAFE_TOOLS, and the codebase adapter injects the client — so the
 * chain registry → adapter → client → assistant.tools.ts already exists. The
 * moment assistant.tools.ts injects a service that reaches back into the
 * connectors layer (the code research tools do), that chain is a cycle. A leaf
 * that imports nothing but contracts cannot be part of one.
 */

/**
 * Everything a tool run is allowed to see. `workspaceId` is pinned from the
 * request AFTER AclGuard verified the caller's membership — the model's tool
 * arguments can never widen it, so a prompt-injected "read workspace X"
 * instruction dead-ends here (context-engineering containment).
 */
export interface AssistantToolContext {
  principal: Principal;
  workspaceId: string;
}

export interface AssistantToolResult {
  /** JSON string fed back to the model as the tool message. */
  content: string;
  ok: boolean;
  /** What this call cited — workspace pages, or web pages it retrieved. */
  sources: AssistantSource[];
  /** Set only by render_component — an existing product component (GraphView/ActivityFeed/
   * SearchWidget) the assistant wants the chat pane to render inline for this turn. */
  uiBlock?: AssistantUiBlock;
  /** Set by ask_user / request_agent_mode — a question for the user that ends the turn. */
  prompt?: AssistantPrompt;
}

/**
 * The five tools that only ever read the workspace. Owned by
 * AssistantReadToolsService, which re-exports the set; declared here so the
 * parallel-safe union below can be built without importing a service file.
 */
export const READ_TOOL_NAMES = new Set([
  'search_knowledge',
  'read_document',
  'explore_document_graph',
  'list_relations',
  'list_document_tree',
]);

/**
 * Tools that do not count against the turn's tool budget.
 *
 * The budget bounds *work* — searches, reads, graph walks, writes. Asking the
 * user something is not work: it touches nothing, and it is how a turn that
 * has run out of room is supposed to end. Billing it produced exactly the
 * failure it should have prevented: the model spent its budget finding out
 * what the options were, then had no tool left to offer them with, and wrote
 * the question out as prose for the user to answer by hand.
 */
export const FREE_TOOLS = new Set(['ask_user', 'request_agent_mode']);

/**
 * The two tools that leave the workspace (docs/features/25).
 *
 * Offered only when the caller opts in — `definitions(mode, { web: true })` —
 * and never by default. `/v1/assistant/ask` is the one model call site with no
 * agent behind it, so an allowlist cannot narrow what it is handed; adding
 * these to the base list would silently widen a page-scoped question into the
 * open web. Every list stays explicit.
 */
export const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

/**
 * The tools that read a connected repository (docs/features/31). Opt-in the
 * same way as the web pair — `definitions(mode, { code: true })` — and offered
 * only when the workspace actually has a repository connector to read.
 */
export const CODE_TOOLS = new Set<string>(ASSISTANT_CODE_TOOL_NAMES);

/**
 * Tools the harness may run concurrently inside one round (docs/features/29).
 *
 * An allowlist of calls known to have no side effects — deliberately NOT the
 * complement of the write set. An `mcp__<slug>__<tool>` call is an external
 * server's code whose effects this process cannot see, so reading "not a
 * declared write" as "safe to batch" would parallelise somebody else's
 * mutation, and a batch in flight cannot be interrupted between its members the
 * way a serial loop can.
 *
 * Reads are also where the whole win is: ten `web_fetch` calls in one round
 * were ten sequential fetches, which at WEB_TIMEOUT_MS apiece is minutes of
 * wall clock for work the model asked to do at once.
 */
export const PARALLEL_SAFE_TOOLS = new Set<string>([...READ_TOOL_NAMES, ...WEB_TOOLS, ...CODE_TOOLS]);
