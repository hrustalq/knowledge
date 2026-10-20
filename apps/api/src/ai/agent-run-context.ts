import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The background agent run the current code is executing for (#305).
 *
 * Opened once by `AgentExecutor.run`, so every model call a run makes, through
 * whichever service makes it (the glossarist calls the settings page's
 * `suggest`), is attributed to the run without threading two ids through every
 * `AiCallContext`. `AiUsageService.record` reads it. Outside a run it is
 * undefined and the usage row stays unattributed, which is the truth.
 */
export interface AgentRunContext {
  agentKey: string;
  agentRunId: string;
}

const store = new AsyncLocalStorage<AgentRunContext>();

export function withAgentRun<T>(ctx: AgentRunContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentAgentRun(): AgentRunContext | undefined {
  return store.getStore();
}
