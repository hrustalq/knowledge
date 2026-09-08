export const WORKFLOW_QUEUE = 'workflow';

/** How long a node may sit in `running` before the sweeper assumes the worker
 *  that claimed it died. Generous: a drafting step with tools can take minutes. */
export const WORKFLOW_NODE_STALE_MS = 15 * 60_000;

/** Retry ceiling for the sweeper. A node that has failed this often needs a
 *  person to look at the prompt, not another model call. */
export const WORKFLOW_MAX_ATTEMPTS = 3;
