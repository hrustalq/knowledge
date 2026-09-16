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
