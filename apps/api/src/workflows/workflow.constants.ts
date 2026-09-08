export const WORKFLOW_QUEUE = 'workflow';

/** Retry ceiling for the sweeper. A node that has failed this often needs a
 *  person to look at the prompt, not another model call. */
export const WORKFLOW_MAX_ATTEMPTS = 3;
