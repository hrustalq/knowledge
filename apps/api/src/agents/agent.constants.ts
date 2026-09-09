export const AGENT_QUEUE = 'agent';

/**
 * Retry ceiling for the stale sweeper. A run that has failed this often needs a
 * person to look at the prompt, not another model call — the same reasoning as
 * WORKFLOW_MAX_ATTEMPTS.
 */
export const AGENT_MAX_ATTEMPTS = 3;
